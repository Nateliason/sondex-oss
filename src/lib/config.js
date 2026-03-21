import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_PORT = 3200;
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/sondex';
export const DEFAULT_EMAIL_POLL_INTERVAL_SECONDS = 300;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveConfigPath(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  if (process.env.SONDEX_CONFIG_PATH) {
    return path.resolve(process.env.SONDEX_CONFIG_PATH);
  }

  return path.join(os.homedir(), '.config', 'sondex', 'config.json');
}

export async function loadConfig({ configPath, required = true } = {}) {
  const resolvedPath = resolveConfigPath(configPath);
  let fileConfig = {};

  try {
    const raw = await fs.readFile(resolvedPath, 'utf8');
    fileConfig = JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    if (required && !process.env.DATABASE_URL) {
      throw new Error(`Missing config at ${resolvedPath}. Run \"sondex init\" first.`);
    }
  }

  return {
    _configPath: resolvedPath,
    port: parseNumber(process.env.PORT ?? fileConfig.port, DEFAULT_PORT),
    database_url: process.env.DATABASE_URL ?? fileConfig.database_url,
    anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? fileConfig.anthropic_api_key ?? '',
    openclaw_webhook_url: process.env.OPENCLAW_WEBHOOK_URL ?? fileConfig.openclaw_webhook_url ?? '',
    agentmail: {
      api_key: process.env.AGENTMAIL_API_KEY ?? fileConfig.agentmail?.api_key ?? '',
      inbox: process.env.AGENTMAIL_INBOX ?? fileConfig.agentmail?.inbox ?? '',
      webhook_secret:
        process.env.AGENTMAIL_WEBHOOK_SECRET ?? fileConfig.agentmail?.webhook_secret ?? ''
    },
    stripe: {
      api_key: process.env.STRIPE_API_KEY ?? fileConfig.stripe?.api_key ?? '',
      webhook_secret: process.env.STRIPE_WEBHOOK_SECRET ?? fileConfig.stripe?.webhook_secret ?? ''
    },
    gmail: {
      client_id: process.env.GMAIL_CLIENT_ID ?? fileConfig.gmail?.client_id ?? '',
      client_secret: process.env.GMAIL_CLIENT_SECRET ?? fileConfig.gmail?.client_secret ?? '',
      refresh_token: process.env.GMAIL_REFRESH_TOKEN ?? fileConfig.gmail?.refresh_token ?? '',
      poll_interval_seconds: parseNumber(
        process.env.GMAIL_POLL_INTERVAL_SECONDS ?? fileConfig.gmail?.poll_interval_seconds,
        DEFAULT_EMAIL_POLL_INTERVAL_SECONDS
      )
    },
    imap: {
      host: process.env.IMAP_HOST ?? fileConfig.imap?.host ?? '',
      port: parseNumber(process.env.IMAP_PORT ?? fileConfig.imap?.port, 993),
      user: process.env.IMAP_USER ?? fileConfig.imap?.user ?? '',
      password: process.env.IMAP_PASSWORD ?? fileConfig.imap?.password ?? '',
      tls: parseBoolean(process.env.IMAP_TLS ?? fileConfig.imap?.tls, true),
      poll_interval_seconds: parseNumber(
        process.env.IMAP_POLL_INTERVAL_SECONDS ?? fileConfig.imap?.poll_interval_seconds,
        DEFAULT_EMAIL_POLL_INTERVAL_SECONDS
      )
    }
  };
}

export async function saveConfig(config, { configPath } = {}) {
  const resolvedPath = resolveConfigPath(configPath);
  const dir = path.dirname(resolvedPath);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return resolvedPath;
}
