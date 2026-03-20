import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_PORT = 3200;
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/sondex';

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
    port: Number(process.env.PORT ?? fileConfig.port ?? DEFAULT_PORT),
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
