import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config';
import { HttpError, assertId, resolveInVolume, volumePath } from './safe';
import { BinRow, binAdd, binDrop, binItems, binRemove, binServerIds } from './state';

/**
 * Per-server recycle bin. "Delete" in the file manager moves items here instead of removing them, they stay for
 * RETENTION_DAYS (and still count towards the server's disk limit), then the daemon purges them automatically.
 * The bin lives OUTSIDE the server volume (<DATA_DIR>/recycle/<serverId>) so the server process can never see or edit it.
 * The index of what is in each bin (names, sizes, expiry) is kept in PostgreSQL; the deleted files themselves stay on disk.
 */
export const RETENTION_DAYS = 3;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

export type BinItem = BinRow;

const binDir = (id: string): string => path.join(config.dataDir, 'recycle', assertId(id));
const ITEM_ID = /^[a-f0-9]{16}$/;

const readIndex = (id: string): BinItem[] => binItems(assertId(id)).filter(i => ITEM_ID.test(i.id));

function treeSize(p: string): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { try { for (const n of fs.readdirSync(cur)) stack.push(path.join(cur, n)); } catch { /* unreadable */ } } else total += st.size;
  }
  return total;
}

/** rename() when possible, copy + remove when the bin sits on another filesystem. */
function move(src: string, dest: string): void {
  try { fs.renameSync(src, dest); } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

export function usage(id: string): number {
  return readIndex(id).reduce((n, i) => n + (i.size || 0), 0);
}

export async function moveToBin(id: string, paths: unknown): Promise<number> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) throw new HttpError(400, 'Invalid paths');
  const root = fs.realpathSync(volumePath(id));
  let n = 0;
  for (const rel of paths) {
    const p = resolveInVolume(id, rel);
    if (p === root) throw new HttpError(400, 'Refusing to delete the server root');
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { continue; } // already gone
    if (st.isSymbolicLink()) { fs.rmSync(p, { force: true }); n++; continue; } // links are never kept
    const itemId = crypto.randomBytes(8).toString('hex');
    const dest = path.join(binDir(id), itemId);
    fs.mkdirSync(binDir(id), { recursive: true, mode: 0o750 });
    const size = st.isDirectory() ? treeSize(p) : st.size;
    const dir = '/' + path.relative(root, path.dirname(p)).split(path.sep).filter(Boolean).join('/');
    const now = Date.now();
    const item: BinItem = { id: itemId, name: path.basename(p), dir, type: st.isDirectory() ? 'dir' : 'file', size, deletedAt: new Date(now).toISOString(), expiresAt: new Date(now + RETENTION_MS).toISOString() };
    // Record first, move second: if the database is down nothing was touched, if the move fails the record is withdrawn again.
    await binAdd(id, item);
    try { move(p, dest); } catch (e) { await binRemove(id, [itemId]).catch(() => undefined); throw e; }
    n++;
  }
  return n;
}

export async function list(id: string): Promise<BinItem[]> {
  await purgeExpired(id);
  return readIndex(id).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

function pick(items: BinItem[], ids: unknown, all: boolean): BinItem[] {
  if (all) return items;
  if (!Array.isArray(ids) || ids.length > 1000) throw new HttpError(400, 'Invalid ids');
  const set = new Set(ids.map(String));
  return items.filter(i => set.has(i.id));
}

export async function restore(id: string, ids: unknown, all: boolean): Promise<number> {
  const chosen = pick(readIndex(id), ids, all);
  const root = fs.realpathSync(volumePath(id));
  let n = 0;
  const done: string[] = [];
  try {
    for (const it of chosen) {
      const src = path.join(binDir(id), it.id);
      if (!fs.existsSync(src)) { done.push(it.id); continue; } // the files are gone: drop the stale record
      const dir = resolveInVolume(id, it.dir);
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, it.name);
      for (let k = 1; fs.existsSync(dest); k++) dest = path.join(dir, `${it.name} (restored${k > 1 ? ' ' + k : ''})`);
      if (path.relative(root, dest).startsWith('..')) throw new HttpError(400, 'Path escapes server directory');
      move(src, dest);
      done.push(it.id);
      n++;
    }
  } finally { await binRemove(id, done); } // whatever was restored before an error must not stay listed
  return n;
}

export async function purge(id: string, ids: unknown, all: boolean): Promise<number> {
  const chosen = pick(readIndex(id), ids, all);
  for (const it of chosen) fs.rmSync(path.join(binDir(id), it.id), { recursive: true, force: true });
  await binRemove(id, chosen.map(i => i.id));
  return chosen.length;
}

export async function purgeExpired(id: string): Promise<void> {
  const now = Date.now();
  const dead = readIndex(id).filter(i => new Date(i.expiresAt).getTime() <= now);
  if (!dead.length) return;
  for (const it of dead) fs.rmSync(path.join(binDir(id), it.id), { recursive: true, force: true });
  await binRemove(id, dead.map(i => i.id));
}

export async function removeBin(id: string): Promise<void> {
  fs.rmSync(binDir(id), { recursive: true, force: true });
  await binDrop(assertId(id));
}

/** Hourly sweep so bins of idle servers are cleaned too. */
export async function sweepAll(): Promise<void> {
  for (const id of binServerIds()) { try { await purgeExpired(id); } catch { /* skip odd entries */ } }
}
