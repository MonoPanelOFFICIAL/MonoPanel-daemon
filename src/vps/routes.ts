import { route, Ctx, MB } from '../http';
import { config } from '../config';
import { log } from '../log';
import { HttpError } from '../safe';
import { needVps } from './index';
import { VpsRuntime, VpsSpec } from './types';

const ID = /^[a-z0-9-]{6,40}$/;
const BASE = /^[a-z0-9][a-z0-9._\/-]{0,100}:[A-Za-z0-9._-]{1,60}$/;
const MAX_FILE = 4 * MB;            // largest file the panel may save through the editor
const MAX_BODY = 6 * MB;            // 4 MB file content + JSON overhead

const str = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'Invalid input');
  return v;
};
const vpsId = (id: string): string => {
  if (!ID.test(id)) throw new HttpError(404, 'Not found');
  return id;
};

/** Container-engine errors become clean HTTP errors (same messages the panel has always shown). */
function mapError(e: any): never {
  if (e instanceof HttpError) throw e;
  const msg = String(e?.message || '');
  const gone = /No such container/i.test(msg);                              // docker says this when the VPS container was removed on the node
  const missingFile = e?.code === 'ENOENT' || /No such file|not found/i.test(msg);
  if (gone) throw new HttpError(404, 'VPS not found on this node');
  if (missingFile) throw new HttpError(404, 'No such file or directory');
  log.error('[vps]', msg);
  throw new HttpError(500, (msg || 'Internal error').slice(0, 300));
}

type VpsHandler = (c: Ctx, rt: VpsRuntime) => Promise<unknown> | unknown;
const guard = (fn: VpsHandler) => async (c: Ctx): Promise<unknown> => {
  const rt = needVps();
  try { return await fn(c, rt); } catch (e) { return mapError(e); }
};

const limits = (j: any): { cpu: number; ramMb: number } => ({
  cpu: Math.min(64, Math.max(0.25, +j.cpu || 1)),
  ramMb: Math.min(262144, Math.max(256, +j.ramMb || 1024)),
});

export function registerVpsRoutes(): void {
  route('GET', '/v1/vps', guard(async (_c, rt) => ({ vps: await rt.listAll() })));

  route('POST', '/v1/vps', guard(async ({ body: j }, rt) => {
    const v: VpsSpec = {
      id: str(j.id, 40), image: str(j.image, 40),
      base: j.base ? str(j.base, 160) : '',
      ...limits(j), diskGb: Math.min(4096, Math.max(0, +j.diskGb || 0)),
      hostname: str(j.hostname || '', 63).replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 63), sshPort: +j.sshPort, rootPassword: str(j.rootPassword, 128),
    };
    if (!ID.test(v.id) || !(v.sshPort >= 1024 && v.sshPort <= 65535) || v.rootPassword.length < 8 || /[\r\n:]/.test(v.rootPassword)) throw new HttpError(400, 'Invalid VPS spec');
    if (v.base && (!BASE.test(v.base) || !config.vps.basePrefixes.some(x => v.base.startsWith(x)))) {
      throw new HttpError(400, `Base image "${v.base}" is not allowed on this node (VPS_ALLOWED_BASE_PREFIXES).`);
    }
    if (j.reinstall === true) return { ok: true, ...(await rt.reinstall(v)) };
    return { ok: true, ...(await rt.create(v)) };
  }));

  route('GET', '/v1/vps/:id', guard(({ params }, rt) => rt.stats(vpsId(params.id))));
  route('DELETE', '/v1/vps/:id', guard(async ({ params }, rt) => { await rt.destroy(vpsId(params.id)); return { ok: true }; }));
  route('POST', '/v1/vps/:id/power', guard(async ({ params, body: j }, rt) => { await rt.power(vpsId(params.id), str(j.action, 10)); return { ok: true }; }));
  route('POST', '/v1/vps/:id/resize', guard(async ({ params, body: j }, rt) => { await rt.resize(vpsId(params.id), limits(j)); return { ok: true }; }));
  route('GET', '/v1/vps/:id/logs', guard(async ({ params, query }, rt) => ({ log: await rt.logs(vpsId(params.id), +(query.get('tail') || 0) || 300) })));
  route('POST', '/v1/vps/:id/exec', guard(({ params, body: j }, rt) => rt.exec(vpsId(params.id), str(j.cmd, 8192), j.cwd ? str(j.cwd, 1024) : '/root')));

  // ---- files (inside the VPS) ------------------------------------------------------------------
  route('GET', '/v1/vps/:id/files', guard(async ({ params, query }, rt) => ({ files: await rt.list(vpsId(params.id), query.get('path') || '/') })));
  route('GET', '/v1/vps/:id/file', guard(async ({ params, query }, rt) => ({ content: await rt.read(vpsId(params.id), query.get('path') || '') })));
  route('PUT', '/v1/vps/:id/file', guard(async ({ params, body: j }, rt) => { await rt.write(vpsId(params.id), str(j.path, 1024), str(j.content, MAX_FILE)); return { ok: true }; }), MAX_BODY);
  route('POST', '/v1/vps/:id/mkdir', guard(async ({ params, body: j }, rt) => { await rt.mkdir(vpsId(params.id), str(j.path, 1024)); return { ok: true }; }));
  route('POST', '/v1/vps/:id/delete', guard(async ({ params, body: j }, rt) => { await rt.remove(vpsId(params.id), str(j.path, 1024)); return { ok: true }; }));
  route('POST', '/v1/vps/:id/rename', guard(async ({ params, body: j }, rt) => { await rt.rename(vpsId(params.id), str(j.from, 1024), str(j.to, 1024)); return { ok: true }; }));

  route('POST', '/v1/vps/:id/password', guard(async ({ params, body: j }, rt) => {
    const pw = str(j.password, 128);
    if (pw.length < 8 || /[\r\n:]/.test(pw)) throw new HttpError(400, 'Invalid password');
    await rt.setPassword(vpsId(params.id), pw);
    return { ok: true };
  }));

  route('GET', '/v1/vps/:id/sshx', guard(({ params }, rt) => rt.sshx(vpsId(params.id), 'status')));
  route('POST', '/v1/vps/:id/sshx', guard(({ params, body: j }, rt) => rt.sshx(vpsId(params.id), j.action === 'stop' ? 'stop' : 'start')));
}
