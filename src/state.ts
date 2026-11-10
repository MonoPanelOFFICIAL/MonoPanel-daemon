import { log } from './log';
import { ServerSpec } from './runtime/types';
import { closeDatabase, databaseLabel, jsonText, openDatabase, query, tables, transaction } from './db';

/**
 * Node-local state: the specs of the servers this daemon runs, installer progress and the recycle-bin index.
 *
 * Storage: PostgreSQL only (see db.ts). The daemon keeps a copy in memory so reads stay synchronous and instant;
 * every write goes to PostgreSQL first and the copy is updated only after the database accepted it, so memory
 * and database can never disagree. Call `initState()` once at startup, before anything else touches this module.
 */
export type InstallState = 'installing' | 'installed' | 'failed';
type Install = { state: InstallState; log: string[] };
export interface BinRow { id: string; name: string; dir: string; type: 'file' | 'dir'; size: number; deletedAt: string; expiresAt: string }

const specs = new Map<string, ServerSpec>();
const installs = new Map<string, Install>();
const bins = new Map<string, BinRow[]>();
let ready = false;

/** All writes run one after another, so two overlapping requests can never interleave their SQL. */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Connect to PostgreSQL, create the tables and load the working set. Throws (and the daemon refuses to start) if that fails. */
export async function initState(): Promise<void> {
  await openDatabase();
  for (const r of await query(`SELECT data::text AS data FROM ${tables.servers} ORDER BY id`)) {
    try { const s = JSON.parse(r.data) as ServerSpec; if (s?.id) specs.set(s.id, s); } catch { log.warn('Skipping an unreadable server definition in the database'); }
  }
  for (const r of await query(`SELECT id, state, log::text AS log FROM ${tables.installs}`)) {
    try { installs.set(r.id, { state: r.state as InstallState, log: JSON.parse(r.log) as string[] }); } catch { /* skip */ }
  }
  for (const r of await query(`SELECT server_id, id, name, dir, type, size::text AS size, deleted_at, expires_at FROM ${tables.recycle} ORDER BY deleted_at`)) {
    const list = bins.get(r.server_id) || [];
    list.push({ id: r.id, name: r.name, dir: r.dir, type: r.type, size: Number(r.size), deletedAt: new Date(r.deleted_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString() });
    bins.set(r.server_id, list);
  }
  ready = true;
}

/** Flush pending writes and release the database (frees the single-daemon lock). */
export async function closeState(): Promise<void> {
  try { await flushInstalls(); } catch { /* ignore */ }
  try { await chain; } catch { /* ignore */ }
  await closeDatabase();
}

/** Which storage the daemon is using (shown at startup). */
export const stateBackend = (): string => databaseLabel();

const need = (): void => { if (!ready) throw new Error('State is not initialised (initState() has not run)'); };

// ------------------------------------------------------------------------------------------------ server definitions
export function loadSpec(id: string): ServerSpec | null { need(); return specs.get(id) || null; }
export function listSpecs(): ServerSpec[] { need(); return [...specs.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); }

export async function saveSpec(spec: ServerSpec): Promise<void> {
  need();
  const text = jsonText(spec);
  await enqueue(() => query(
    `INSERT INTO ${tables.servers} (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [spec.id, text]));
  specs.set(spec.id, JSON.parse(text) as ServerSpec);   // keep exactly what the database holds
}

export async function deleteSpec(id: string): Promise<void> {
  need();
  await enqueue(() => query(`DELETE FROM ${tables.servers} WHERE id = $1`, [id]));
  specs.delete(id);
}

// ------------------------------------------------------------------------------------------------ installer progress
// Install log lines arrive in bursts, so they are written in small batches; the final state (installed / failed) is written at once.
const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

function flushInstalls(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty.size) return Promise.resolve();
  const ids = [...dirty]; dirty.clear();
  return enqueue(() => transaction(async q => {
    for (const id of ids) {
      const cur = installs.get(id);
      if (cur) await q(`INSERT INTO ${tables.installs} (id, state, log, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, log = EXCLUDED.log, updated_at = now()`, [id, cur.state, jsonText(cur.log)]);
      else await q(`DELETE FROM ${tables.installs} WHERE id = $1`, [id]);
    }
  })).catch(e => { for (const id of ids) dirty.add(id); log.warn(`Could not save installer progress (will retry): ${e?.message}`); });
}

export function setInstall(id: string, state: InstallState, line?: string): void {
  need();
  const cur = installs.get(id) || { state, log: [] };
  cur.state = state;
  if (line) { cur.log.push(line.slice(0, 400)); if (cur.log.length > 60) cur.log.shift(); }
  installs.set(id, cur);
  dirty.add(id);
  if (state !== 'installing') void flushInstalls();
  else if (!flushTimer) { flushTimer = setTimeout(() => { flushTimer = null; void flushInstalls(); }, 300); flushTimer.unref?.(); }
}
export function getInstall(id: string): Install | null { need(); return installs.get(id) || null; }
export async function clearInstall(id: string): Promise<void> {
  need();
  installs.delete(id); dirty.delete(id);
  await enqueue(() => query(`DELETE FROM ${tables.installs} WHERE id = $1`, [id]));
}

// ------------------------------------------------------------------------------------------------ recycle bin index (files stay on disk, see recycle.ts)
export function binItems(serverId: string): BinRow[] { need(); return (bins.get(serverId) || []).slice(); }
export function binServerIds(): string[] { need(); return [...bins.keys()]; }

export async function binAdd(serverId: string, it: BinRow): Promise<void> {
  need();
  await enqueue(() => query(
    `INSERT INTO ${tables.recycle} (server_id, id, name, dir, type, size, deleted_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [serverId, it.id, it.name, it.dir, it.type, it.size, it.deletedAt, it.expiresAt]));
  const list = bins.get(serverId) || []; list.push(it); bins.set(serverId, list);
}

export async function binRemove(serverId: string, ids: string[]): Promise<void> {
  need();
  if (!ids.length) return;
  await enqueue(() => query(`DELETE FROM ${tables.recycle} WHERE server_id = $1 AND id = ANY($2::text[])`, [serverId, ids]));
  const gone = new Set(ids);
  const left = (bins.get(serverId) || []).filter(i => !gone.has(i.id));
  if (left.length) bins.set(serverId, left); else bins.delete(serverId);
}

export async function binDrop(serverId: string): Promise<void> {
  need();
  await enqueue(() => query(`DELETE FROM ${tables.recycle} WHERE server_id = $1`, [serverId]));
  bins.delete(serverId);
}
