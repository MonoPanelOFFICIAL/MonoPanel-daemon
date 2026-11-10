// Mock runtime for development WITHOUT Docker (VPS_RUNTIME=mock). Simulated VPSes live in memory; files live in DATA_DIR/mock/<id>.
// Commands are emulated (echo, pwd, ls, cat, cd, whoami, uname, uptime); nothing is executed on the host.
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { HttpError } from '../safe';
import { VpsExecResult, VpsFileEntry, VpsRuntime, VpsSpec, VpsSshx, VpsState, VpsStats } from './types';

const posix = path.posix;

interface MockVps extends VpsSpec { status: 'running' | 'offline'; startedAt: string | null; log: string[]; sshx: string | null }

export function createMockRuntime(): VpsRuntime {
  const vps = new Map<string, MockVps>();
  const root = (id: string): string => path.join(config.dataDir, 'mock', id);
  const real = (id: string, p: unknown): string => {
    const n = posix.normalize(String(p || '/'));
    if (!n.startsWith('/') || n.includes('\0')) throw new HttpError(400, 'Path must be absolute');
    const f = path.join(root(id), n);
    if (!f.startsWith(root(id))) throw new HttpError(400, 'Bad path');
    return f;
  };
  const get = (id: string): MockVps => {
    const v = vps.get(id);
    if (!v) throw new HttpError(404, 'VPS not found on this node');
    return v;
  };
  const log = (v: MockVps, l: string): void => { v.log.push(`${new Date().toISOString()} ${l}`); if (v.log.length > 500) v.log.shift(); };
  const abs = (cwd: string, a: string): string => (a.startsWith('/') ? a : posix.join(cwd, a));

  const self: VpsRuntime = {
    kind: 'mock',
    async info() { return { runtime: 'mock', version: 'dev' }; },

    async create(v: VpsSpec) {
      if (vps.has(v.id)) throw new HttpError(409, 'A VPS with this id already exists on the node.');
      fs.mkdirSync(root(v.id) + '/root', { recursive: true });
      fs.mkdirSync(root(v.id) + '/etc', { recursive: true });
      fs.writeFileSync(root(v.id) + '/etc/hostname', (v.hostname || 'vps') + '\n');
      fs.writeFileSync(root(v.id) + '/root/README.txt', 'Welcome to your MonoPanel VPS (mock runtime).\n');
      const n: MockVps = { ...v, status: 'running', startedAt: new Date().toISOString(), log: [], sshx: null };
      vps.set(v.id, n);
      log(n, `Created ${v.image} · ${v.cpu} vCPU · ${v.ramMb} MB RAM`); log(n, 'sshd listening on :22'); log(n, 'Boot complete.');
      return { diskEnforced: !!v.diskGb };
    },
    async resize(id: string, { cpu, ramMb }: { cpu: number; ramMb: number }) { const v = get(id); v.cpu = cpu; v.ramMb = ramMb; log(v, `Resized to ${cpu} vCPU / ${ramMb} MB`); },
    async listAll() { return [...vps.entries()].map(([id, v]) => ({ id, status: v.status })); },
    async power(id: string, a: string) {
      const v = get(id);
      const states: Record<string, 'running' | 'offline'> = { start: 'running', stop: 'offline', kill: 'offline', restart: 'running' };
      const m = states[a];
      if (!m) throw new HttpError(400, 'Bad action');
      v.status = m; v.startedAt = m === 'running' ? new Date().toISOString() : null; log(v, `Power: ${a}`);
    },
    async inspect(id: string): Promise<VpsState> { const v = vps.get(id); return v ? { exists: true, status: v.status, startedAt: v.startedAt } : { exists: false, status: 'missing' }; },
    async stats(id: string): Promise<VpsStats> {
      const v = get(id); const on = v.status === 'running';
      return {
        exists: true, status: v.status, startedAt: v.startedAt, cpuPct: on ? +(Math.random() * 12).toFixed(1) : 0,
        ramUsedMb: on ? Math.round(v.ramMb * (0.08 + Math.random() * 0.1)) : 0, diskUsedMb: 612, netRxMb: on ? 14.2 : 0, netTxMb: on ? 3.1 : 0,
      };
    },
    async logs(id: string) { return get(id).log.join('\n'); },
    async exec(id: string, cmd: string, cwd = '/root'): Promise<VpsExecResult> {
      const v = get(id);
      if (v.status !== 'running') return { output: 'VPS is offline.', code: 1, cwd };
      const [c, ...a] = cmd.trim().split(/\s+/); const arg = a.join(' ');
      const out = (s: string): VpsExecResult => ({ output: s, code: 0, cwd });
      switch (c) {
        case '': return out('');
        case 'echo': return out(arg);
        case 'pwd': return out(cwd);
        case 'whoami': return out('root');
        case 'uname': return out('Linux ' + (v.hostname || 'vps') + ' 6.8.0 x86_64 GNU/Linux');
        case 'uptime': return out(' up ' + Math.round((Date.now() - new Date(v.startedAt || Date.now()).getTime()) / 60000) + ' min');
        case 'cd': {
          const t = posix.normalize(arg.startsWith('/') ? arg : posix.join(cwd, arg || '/root'));
          return fs.existsSync(real(id, t)) ? { output: '', code: 0, cwd: t } : { output: `bash: cd: ${arg}: No such file or directory`, code: 1, cwd };
        }
        case 'ls': try { return out(fs.readdirSync(real(id, abs(cwd, arg))).join('  ')); } catch { return { output: `ls: cannot access '${arg}'`, code: 2, cwd }; }
        case 'cat': try { return out(fs.readFileSync(real(id, abs(cwd, arg)), 'utf8')); } catch { return { output: `cat: ${arg}: No such file`, code: 1, cwd }; }
        default: return { output: `bash: ${c}: mock runtime only emulates a few commands (use VPS_RUNTIME=docker on a real node)`, code: 127, cwd };
      }
    },
    async list(id: string, p: string): Promise<VpsFileEntry[]> {
      const d = real(id, p);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d, { withFileTypes: true }).map(e => {
        const s = fs.statSync(path.join(d, e.name));
        return { name: e.name, dir: e.isDirectory(), link: false, size: s.size, modified: s.mtimeMs };
      }).sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
    },
    async read(id: string, p: string) {
      const f = real(id, p);
      if (fs.statSync(f).size > 2 * 1024 * 1024) throw new HttpError(413, 'File is larger than 2 MB.');
      return fs.readFileSync(f, 'utf8');
    },
    async write(id: string, p: string, c: string) { fs.mkdirSync(path.dirname(real(id, p)), { recursive: true }); fs.writeFileSync(real(id, p), c); },
    async mkdir(id: string, p: string) { fs.mkdirSync(real(id, p), { recursive: true }); },
    async remove(id: string, p: string) {
      if (posix.normalize(p) === '/') throw new HttpError(400, 'Refusing to delete /');
      fs.rmSync(real(id, p), { recursive: true, force: true });
    },
    async rename(id: string, a: string, b: string) { fs.renameSync(real(id, a), real(id, b)); },
    async setPassword(id: string) { get(id); },
    async sshx(id: string, action: 'start' | 'stop' | 'status'): Promise<VpsSshx> {
      const v = get(id);
      if (action === 'start') v.sshx = 'https://sshx.io/s/mock-' + id.slice(0, 6) + '#demo';
      if (action === 'stop') v.sshx = null;
      return { running: !!v.sshx, url: v.sshx };
    },
    async destroy(id: string) { vps.delete(id); fs.rmSync(root(id), { recursive: true, force: true }); },
    async reinstall(v: VpsSpec) { await self.destroy(v.id); return self.create(v); },
  };
  return self;
}
