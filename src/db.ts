import fs from 'fs';
import { config } from './config';
import type { Pool, PoolClient } from 'pg';

/**
 * The daemon's only database: PostgreSQL (DATABASE_URL). No SQLite, no JSON files.
 *
 *  - One daemon process per database/prefix: a session-level advisory lock refuses a second one, because the daemon
 *    keeps a copy of its state in memory (reads are synchronous and instant, writes go to PostgreSQL first).
 *  - Give every node its own database (or its own DATABASE_TABLE_PREFIX): this state describes the containers of ONE machine.
 *  - Behind PgBouncer use session pooling: transaction pooling cannot hold the advisory lock.
 */
export interface Tables { servers: string; installs: string; recycle: string; meta: string }

let pool: Pool | null = null;
let lockClient: PoolClient | null = null;
let version = 'PostgreSQL';
export let tables: Tables;

const describe = (url: string): string => { try { const u = new URL(url); return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch { return 'postgres'; } };
export const databaseLabel = (): string => `PostgreSQL ${version} (${describe(config.database.url)})`;

function sslOption(): any {
  const { ssl, sslCa } = config.database;
  const ca = sslCa ? fs.readFileSync(sslCa, 'utf8') : undefined;
  if (!ssl) return ca ? { ca, rejectUnauthorized: true } : undefined;   // otherwise the sslmode in the URL decides
  if (['disable', 'false', '0', 'off'].includes(ssl)) return false;
  if (['no-verify', 'insecure'].includes(ssl)) return { rejectUnauthorized: false };
  if (['require', 'verify', 'verify-full', 'true', '1', 'on'].includes(ssl)) return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  throw new Error('DATABASE_SSL must be one of: disable, require, verify, no-verify');
}

/** Connect, take the single-daemon lock and create the tables. Throws a readable error if anything is wrong. */
export async function openDatabase(): Promise<void> {
  const { url, prefix, poolMax } = config.database;
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error('DATABASE_URL is not set. The daemon stores its state in PostgreSQL, e.g. DATABASE_URL=postgres://daemon:change-me@127.0.0.1:5432/monopanel_daemon');
  }
  if (prefix !== '' && !/^[a-z][a-z0-9_]{0,20}$/i.test(prefix)) throw new Error('DATABASE_TABLE_PREFIX may only contain letters, digits and underscores');
  tables = { servers: `${prefix}servers`, installs: `${prefix}installs`, recycle: `${prefix}recycle`, meta: `${prefix}meta` };

  let pg: typeof import('pg');
  try { pg = await import('pg'); } catch { throw new Error('The "pg" package is not installed. Run: npm install'); }
  const Pool = (pg as any).Pool ?? (pg as any).default?.Pool;
  pool = new Pool({ connectionString: url, max: poolMax + 1, ssl: sslOption(), application_name: 'monopanel-daemon', connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }) as Pool;
  // An idle connection dying (database restart, failover) must not crash the daemon.
  pool.on('error', e => console.error('[state/ERROR] PostgreSQL pool error:', e.message));

  try {
    const lock = await pool.connect();
    lock.on('error', e => console.error('[state/ERROR] PostgreSQL lock connection lost:', e.message));
    const got = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`monopanel-daemon:${prefix}`]);
    if (!got.rows[0]?.ok) { lock.release(true); throw new Error('Another MonoPanel daemon is already using this database. Use a separate database (or DATABASE_TABLE_PREFIX) per node.'); }
    lockClient = lock;
    version = String((await lock.query('SHOW server_version')).rows[0]?.server_version || '');
  } catch (e: any) {
    await pool.end().catch(() => undefined);
    pool = null;
    if (/already using this database/.test(e.message)) throw e;
    throw new Error(`Could not connect to PostgreSQL at ${describe(url)}: ${String(e.message).replace(url, '<url>')}`);
  }

  const t = tables;
  await query(`CREATE TABLE IF NOT EXISTS ${t.servers} (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS ${t.installs} (id text PRIMARY KEY, state text NOT NULL, log jsonb NOT NULL DEFAULT '[]'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS ${t.recycle} (server_id text NOT NULL, id text NOT NULL, name text NOT NULL, dir text NOT NULL, type text NOT NULL, size bigint NOT NULL DEFAULT 0, deleted_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY (server_id, id))`);
  await query(`CREATE INDEX IF NOT EXISTS ${t.recycle}_expiry ON ${t.recycle} (expires_at)`);
  await query(`CREATE TABLE IF NOT EXISTS ${t.meta} (k text PRIMARY KEY, v text NOT NULL)`);
  await query(`INSERT INTO ${t.meta} (k, v) VALUES ('schema_version', '1') ON CONFLICT (k) DO NOTHING`);
}

/** JSON text for a jsonb column. jsonb cannot store the NUL character, so an escaped NUL (backslash-u-0000) is stripped. */
export const jsonText = (v: unknown): string => JSON.stringify(v).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1');

export async function query(sql: string, params: any[] = []): Promise<any[]> {
  if (!pool) throw new Error('Database is not open');
  return (await pool.query(sql, params)).rows;
}

/** Run fn atomically: everything it writes is committed together or not at all. */
export async function transaction<T>(fn: (q: (sql: string, params?: any[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('Database is not open');
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    const out = await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { broken = true; }   // unusable connection: discard it instead of pooling it again
    throw e;
  } finally { c.release(broken); }
}

/** Release the lock and close every connection. */
export async function closeDatabase(): Promise<void> {
  try { lockClient?.release(true); } catch { /* ignore */ }   // closing the connection drops the advisory lock
  lockClient = null;
  try { await pool?.end(); } catch { /* ignore */ }
  pool = null;
}
