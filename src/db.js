// Database access. Production (xhostd) injects DATABASE_URL for a managed Postgres.
// Local development without DATABASE_URL falls back to an embedded PGlite (Postgres in WASM),
// so the same SQL runs in both places.
import pg from 'pg';

let impl = null;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    pool.on('error', (err) => console.error('[db] idle client error', err));
    impl = {
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
    console.log('[db] using Postgres from DATABASE_URL');
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = process.env.PGLITE_DIR || './.pglite';
  const db = new PGlite(dataDir);
  impl = {
    query: (text, params) => db.query(text, params),
    exec: (text) => db.exec(text),
    close: () => db.close(),
  };
  console.log(`[db] using local PGlite at ${dataDir}`);
}

export async function query(text, params = []) {
  if (!impl) throw new Error('Database not initialised');
  const result = await impl.query(text, params);
  return { rows: result.rows };
}

export async function exec(text) {
  if (!impl) throw new Error('Database not initialised');
  await impl.exec(text);
}

export async function closeDb() {
  if (impl) await impl.close();
}
