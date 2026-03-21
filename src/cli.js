#!/usr/bin/env node

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { google } from 'googleapis';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_EMAIL_POLL_INTERVAL_SECONDS,
  DEFAULT_PORT,
  loadConfig,
  resolveConfigPath,
  saveConfig
} from './lib/config.js';
import { startServer } from './server.js';
import { getEnabledEmailSources } from './services/email-sync.js';

const program = new Command();

function openBrowser(url) {
  const byPlatform = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : [['xdg-open', [url]]];

  for (const [command, args] of byPlatform) {
    try {
      const launched = spawnSync(command, args, { stdio: 'ignore' });
      if (!launched.error) {
        return true;
      }
    } catch (error) {
      // Keep trying fallback launchers below.
    }
  }

  return false;
}

function waitForOAuthCode(redirectUri, timeoutMs = 180000) {
  const parsed = new URL(redirectUri);
  const localHostnames = new Set(['127.0.0.1', 'localhost']);
  if (parsed.protocol !== 'http:' || !localHostnames.has(parsed.hostname)) {
    return Promise.resolve(null);
  }

  const port = Number(parsed.port || 80);
  const pathname = parsed.pathname || '/';

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const finish = (value, error = null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      server.close(() => {
        if (error) {
          reject(error);
          return;
        }

        resolve(value);
      });
    };

    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (incoming.pathname !== pathname) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const error = incoming.searchParams.get('error');
      const code = incoming.searchParams.get('code');

      if (error) {
        res.statusCode = 400;
        res.end(`OAuth error: ${error}`);
        finish(null, new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.end('Missing OAuth code');
        return;
      }

      res.end('Gmail connected. You can return to your terminal.');
      finish(code);
    });

    server.once('error', (error) => finish(null, error));
    server.listen(port, parsed.hostname);

    timeout = setTimeout(() => {
      finish(null);
    }, timeoutMs);
  });
}

function stripRuntimeFields(config) {
  const { _configPath, ...persisted } = config;
  return persisted;
}

program
  .name('sondex')
  .description('Self-hosted Sondex with local Postgres')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize ~/.config/sondex/config.json and run migrations')
  .option('-c, --config <path>', 'Custom config path')
  .option('--database-url <url>', 'Postgres connection string')
  .option('--port <port>', 'HTTP port', String(DEFAULT_PORT))
  .action(async (options) => {
    const configPath = resolveConfigPath(options.config);

    const initial = {
      port: Number(options.port ?? DEFAULT_PORT),
      database_url: options.databaseUrl,
      anthropic_api_key: '',
      agentmail: {
        api_key: '',
        inbox: '',
        webhook_secret: ''
      },
      stripe: {
        api_key: '',
        webhook_secret: ''
      },
      gmail: {
        client_id: '',
        client_secret: '',
        refresh_token: '',
        poll_interval_seconds: DEFAULT_EMAIL_POLL_INTERVAL_SECONDS
      },
      imap: {
        host: '',
        port: 993,
        user: '',
        password: '',
        tls: true,
        poll_interval_seconds: DEFAULT_EMAIL_POLL_INTERVAL_SECONDS
      },
      openclaw_webhook_url: 'http://localhost:4440/api/system-event'
    };

    if (!initial.database_url && input.isTTY) {
      const rl = readline.createInterface({ input, output });
      const response = await rl.question(
        `Postgres connection string [${DEFAULT_DATABASE_URL}]: `
      );
      rl.close();
      initial.database_url = response.trim() || DEFAULT_DATABASE_URL;
    }

    initial.database_url = initial.database_url ?? DEFAULT_DATABASE_URL;

    await saveConfig(initial, { configPath });

    const { pool } = createDb(initial.database_url);
    try {
      const result = await runMigrations(pool);
      console.log(
        `Initialized config at ${configPath}. Migrations applied: ${result.applied}/${result.total}.`
      );
    } finally {
      await pool.end();
    }
  });

program
  .command('connect-gmail')
  .description('Open Gmail OAuth flow and store refresh token in config')
  .option('-c, --config <path>', 'Custom config path')
  .option(
    '--redirect-uri <uri>',
    'OAuth redirect URI (must match your Google OAuth app)',
    'http://127.0.0.1:43123/oauth2callback'
  )
  .action(async (options) => {
    const config = await loadConfig({ configPath: options.config, required: true });

    if (!config.gmail.client_id || !config.gmail.client_secret) {
      throw new Error(
        'Missing gmail.client_id or gmail.client_secret in config (or env). Configure them before running connect-gmail.'
      );
    }

    const oauth = new google.auth.OAuth2(config.gmail.client_id, config.gmail.client_secret, options.redirectUri);
    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/gmail.readonly']
    });

    if (openBrowser(authUrl)) {
      console.log('Opened browser for Gmail authorization.');
    } else {
      console.log('Open this URL in your browser to continue OAuth:');
      console.log(authUrl);
    }

    let code = await waitForOAuthCode(options.redirectUri);

    if (!code && input.isTTY) {
      const rl = readline.createInterface({ input, output });
      code = (await rl.question('Paste OAuth code: ')).trim();
      rl.close();
    }

    if (!code) {
      throw new Error('No OAuth code received. Re-run and complete the authorization flow.');
    }

    const tokenResponse = await oauth.getToken(code);
    oauth.setCredentials(tokenResponse.tokens);

    const refreshToken = tokenResponse.tokens.refresh_token ?? config.gmail.refresh_token;
    if (!refreshToken) {
      throw new Error(
        'OAuth completed but no refresh token was returned. Revoke app access and retry with prompt=consent.'
      );
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    const nextConfig = stripRuntimeFields({
      ...config,
      gmail: {
        ...config.gmail,
        refresh_token: refreshToken
      }
    });

    await saveConfig(nextConfig, { configPath: config._configPath });

    console.log(
      `Saved Gmail refresh token for ${profile.data.emailAddress ?? 'your account'} at ${resolveConfigPath(options.config)}`
    );
  });

program
  .command('migrate')
  .description('Run database migrations')
  .option('-c, --config <path>', 'Custom config path')
  .action(async (options) => {
    const config = await loadConfig({ configPath: options.config, required: true });
    const { pool } = createDb(config.database_url);

    try {
      const result = await runMigrations(pool);
      console.log(`Migrations applied: ${result.applied}/${result.total}.`);
    } finally {
      await pool.end();
    }
  });

program
  .command('start')
  .description('Start the Sondex HTTP server')
  .option('-c, --config <path>', 'Custom config path')
  .action(async (options) => {
    const config = await loadConfig({ configPath: options.config, required: false });

    if (!config.database_url) {
      throw new Error('Missing database_url in config or DATABASE_URL env var. Run "sondex init" first.');
    }

    await startServer(config);

    console.log(`Sondex API listening on http://localhost:${config.port}`);
  });

program
  .command('status')
  .description('Check runtime and database status')
  .option('-c, --config <path>', 'Custom config path')
  .action(async (options) => {
    const config = await loadConfig({ configPath: options.config, required: false });

    if (!config.database_url) {
      console.log(`not_initialized config_path=${resolveConfigPath(options.config)}`);
      process.exit(1);
    }

    const { pool } = createDb(config.database_url);

    try {
      await pool.query('SELECT 1');

      const contactCount = await pool.query('SELECT COUNT(*)::int AS count FROM contacts');
      const lastInteraction = await pool.query('SELECT MAX(created_at) AS ts FROM interactions');
      const lastPayment = await pool.query('SELECT MAX(created_at) AS ts FROM payments');

      const latest = [lastInteraction.rows[0]?.ts, lastPayment.rows[0]?.ts]
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      console.log(`url=http://localhost:${config.port}`);
      console.log(`database=ok`);
      console.log(`contacts=${contactCount.rows[0]?.count ?? 0}`);
      console.log(`last_webhook_received=${latest ? new Date(latest).toISOString() : 'none'}`);
      console.log(`email_sources=${getEnabledEmailSources(config).join(',') || 'none'}`);
    } finally {
      await pool.end();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
