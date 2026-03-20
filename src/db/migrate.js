import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const MIGRATION_TABLE = '__sondex_migrations';

export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((entry) => entry.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const appliedResult = await pool.query(`SELECT name FROM ${MIGRATION_TABLE}`);
  const applied = new Set(appliedResult.rows.map((row) => row.name));

  for (const fileName of files) {
    if (applied.has(fileName)) {
      continue;
    }

    const fullPath = path.join(MIGRATIONS_DIR, fileName);
    const sql = await fs.readFile(fullPath, 'utf8');

    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO ${MIGRATION_TABLE} (name) VALUES ($1)`, [fileName]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw new Error(`Failed migration ${fileName}: ${error.message}`);
    }
  }

  return {
    total: files.length,
    applied: files.filter((name) => !applied.has(name)).length
  };
}
