import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createDb(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('Missing database_url in config. Run "sondex init" to configure it.');
  }

  const pool = new Pool({
    connectionString: databaseUrl
  });

  const db = drizzle(pool, { schema });

  return { db, pool };
}
