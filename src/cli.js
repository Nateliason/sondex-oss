#!/usr/bin/env node

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_PORT,
  loadConfig,
  resolveConfigPath,
  saveConfig
} from './lib/config.js';
import { startServer } from './server.js';

const program = new Command();

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
    } finally {
      await pool.end();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
