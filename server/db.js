import pg from 'pg';

const { Pool } = pg;

let pool;

/** Set `DATABASE_URL` in `server/.env` (see `.env.example`). */
export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'Missing DATABASE_URL. Copy server/.env.example to server/.env and set your PostgreSQL URL.',
    );
  }

  pool = new Pool({ connectionString });
  return pool;
}

/** Smoke-check DB on startup when DATABASE_URL is set. */
export async function warmAuthDb() {
  if (!process.env.DATABASE_URL?.trim()) return;
  await getPool().query('SELECT 1');
}
