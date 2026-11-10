// Docker runtime for VPSes: every VPS is one container (name "monovps-<id>") built from an sshd-enabled ROM image.
//
// Notes carried over from the standalone VPS daemon:
//  * sshd: a drop-in file forces root + password login, which also survives distro images whose sshd_config differs.
//  * The image tag is versioned (":<rev>-<hash of base + ROM>") so changing the base or the ROM builds a fresh image.
//  * Concurrent first-time creates share one image build (build mutex).
//  * A failed create removes the half-created container instead of leaking it (and its SSH port).
//  * sshx stop/start uses "pkill -x sshx" (exact process name) so it never kills its own wrapping shell.
//  * File listing is NUL-delimited, so names containing tabs/newlines cannot corrupt the listing.
//  * Stats are cached for 3 s (docker stats takes 1-2 s and the panel polls every few seconds).
//
// The container name prefix and label ("monovps") are internal identifiers that are kept on purpose: renaming them
// would orphan VPSes that already run on an existing node.
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { HttpError } from '../safe';
import { VpsExecResult, VpsFileEntry, VpsRuntime, VpsSpec, VpsSshx, VpsState, VpsStats } from './types';

const posix = path.posix;

/** Image revision 4 = the MonoPanel ROM (rom/Dockerfile): Docker, Node.js, pm2 and build tools. Bump to force rebuilds. */
const IMAGE_REV = '4';
const ROM_DIR = path.resolve(__dirname, '..', '..', 'rom');
const OS: Record<string, string> = {
  'ubuntu-20.04': 'ubuntu:20.04', 'ubuntu-22.04': 'ubuntu:22.04', 'ubuntu-24.04': 'ubuntu:24.04', 'debian-11': 'debian:11', 'debian-12': 'debian:12',
};

interface RunOpts { soft?: boolean; input?: string; maxBuffer?: number; timeout?: number; tail?: number }
interface RunResult { out: Buffer; text: string; err: string; code: number }

const run = (args: string[], o: RunOpts = {}): Promise<RunResult> => new Promise((resolve, reject) => {
  const p = execFile('docker', args, { maxBuffer: o.maxBuffer || 8 * 1024 * 1024, timeout: o.timeout || 60_000, encoding: 'buffer' }, (e, out, err) => {
    if (e && !o.soft) {
      const m = String(err.length ? err.toString('utf8') : e.message).trim().split('\n').slice(-(o.tail || 1)).join(' | ');
      return reject(new Error(m || 'docker failed'));
    }
    const ec = (e as { code?: unknown } | null)?.code;
    const code = e ? (typeof ec === 'number' && ec ? ec : 1) : 0;
    resolve({ out, text: out.toString('utf8'), err: err.toString('utf8'), code });
  });
  if (o.input !== undefined) p.stdin?.end(o.input);
});

const name = (id: string): string => `monovps-${id}`;
const safePath = (p: unknown): string => {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) throw new HttpError(400, 'Path must be absolute');
  return posix.normalize(p);
};
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const safeTag = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'custom';

const builds = new Map<string, Promise<string>>();   // tag -> in-flight build promise

// Hash of everything in rom/ so editing the Dockerfile or any ROM script produces a new image tag (computed once per daemon start).
let romHashCache: string | null = null;
function romHash(): string {
  if (romHashCache) return romHashCache;
  const h = crypto.createHash('sha1');
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n); const st = fs.statSync(f);
      if (st.isDirectory()) walk(f); else { h.update(path.relative(ROM_DIR, f)); h.update(fs.readFileSync(f)); }
    }
  };
  walk(ROM_DIR);
  return (romHashCache = h.digest('hex').slice(0, 6));
}

async function ensureImage(os: string, customBase?: string): Promise<string> {
  const base = customBase || OS[os];
  if (!base) throw new HttpError(400, `Unsupported image "${os}"`);
  const hash = crypto.createHash('sha1').update(base).update(romHash()).digest('hex').slice(0, 6);
  const tag = `mono-vps/${safeTag(os)}:${IMAGE_REV}-${hash}`;
  if ((await run(['image', 'inspect', tag], { soft: true })).code === 0) return tag;
  const running = builds.get(tag);
  if (running) return running;
  // The panel waits up to 15 min for a create call, so the build must finish inside that.
  const p = run(['build', '-t', tag, '-f', path.join(ROM_DIR, 'Dockerfile'), '--build-arg', `BASE=${base}`, ROM_DIR],
    { timeout: 14 * 60_000, maxBuffer: 64 * 1024 * 1024, tail: 4 }).then(() => tag).finally(() => builds.delete(tag));
  builds.set(tag, p);
  return p;
}

async function setPassword(id: string, pw: string): Promise<void> {
  await run(['exec', '-i', name(id), 'chpasswd'], { input: `root:${pw}\n` });
}

const statCache = new Map<string, { at: number; val: VpsStats }>();   // id -> { at, val }

const mb = (s: string | undefined): number => {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(s || '');
  if (!m) return 0;
  const unit: Record<string, number> = { B: 1 / 1048576, KB: 1 / 1024, KIB: 1 / 1024, MB: 1, MIB: 1, GB: 1024, GIB: 1024, TB: 1048576, TIB: 1048576 };
  return Number(m[1]) * (unit[m[2].toUpperCase()] || 0);
};

export function createDockerRuntime(): VpsRuntime {
  const self: VpsRuntime = {
    kind: 'docker',

    async prebuild(list: string[]): Promise<void> {
      for (const os of list) {
        try {
          console.log(`[vps] pre-building ROM image for ${os}...`);
          console.log(`[vps] ready: ${await ensureImage(os)}`);
        } catch (e: any) { console.error(`[vps] pre-build of ${os} failed: ${e.message}`); }
      }
    },

    async info() {
      const v = (await run(['version', '--format', '{{.Server.Version}}'])).text.trim();
      return { runtime: 'docker', version: v };
    },

    async create(v: VpsSpec) {
      if ((await run(['inspect', '--format', '{{.Id}}', name(v.id)], { soft: true })).code === 0) throw new HttpError(409, 'A VPS with this id already exists on the node.');
      const tag = await ensureImage(v.image, v.base);
      const args = ['run', '-d', '--name', name(v.id), '--hostname', v.hostname || `vps-${v.id.slice(0, 6)}`, '--init', '--restart', 'unless-stopped',
        '--cpus', String(v.cpu || 1), '--memory', `${v.ramMb || 1024}m`, '--memory-swap', `${v.ramMb || 1024}m`, '--pids-limit', '1024',
        '-p', `${v.sshPort}:22`, '--label', 'monovps=1'];
      if (config.vps.ociRuntime) args.push('--runtime', config.vps.ociRuntime);
      else if (config.vps.privileged) args.push('--privileged');   // opt-in (VPS_PRIVILEGED=true): lets Docker run inside the VPS, but root in the VPS can then escape to the host. Prefer sysbox-runc.
      let diskEnforced = !!v.diskGb;
      try {
        try { await run(v.diskGb ? [...args, '--storage-opt', `size=${v.diskGb}g`, tag] : [...args, tag]); }
        catch (e: any) { // storage-opt needs overlay2 on xfs+pquota; fall back to no hard disk quota
          if (v.diskGb && /storage-opt|quota|size/i.test(e.message)) {
            diskEnforced = false;
            await run(['rm', '-f', name(v.id)], { soft: true });
            await run([...args, tag]);
          } else throw e;
        }
        await setPassword(v.id, v.rootPassword);
      } catch (e) { await run(['rm', '-f', '-v', name(v.id)], { soft: true }); throw e; }   // never leak a half-created container
      return { diskEnforced };
    },

    async power(id: string, action: string): Promise<void> {
      const actions: Record<string, string[]> = { start: ['start'], stop: ['stop', '-t', '15'], restart: ['restart', '-t', '15'], kill: ['kill'] };
      const a = actions[action];
      if (!a) throw new HttpError(400, 'Bad action');
      await run([a[0], ...a.slice(1), name(id)]);
      statCache.delete(id);
    },

    /** Live CPU / RAM limit change (docker update). Disk size cannot be changed on a running container. */
    async resize(id: string, { cpu, ramMb }: { cpu: number; ramMb: number }): Promise<void> {
      await run(['update', '--cpus', String(cpu), '--memory', `${ramMb}m`, '--memory-swap', `${ramMb}m`, name(id)]);
    },

    async inspect(id: string): Promise<VpsState> {
      const r = await run(['inspect', '--format', '{{json .State}}', name(id)], { soft: true });
      if (r.code) return { exists: false, status: 'missing' };
      const s = JSON.parse(r.text);
      return { exists: true, status: s.Running ? 'running' : 'offline', startedAt: s.Running ? s.StartedAt : null };
    },

    async listAll() {
      const r = await run(['ps', '-a', '--filter', 'label=monovps=1', '--format', '{{.Names}}\t{{.State}}'], { soft: true });
      return r.text.split('\n').filter(Boolean).map(l => {
        const [n, s] = l.split('\t');
        return { id: n.replace(/^monovps-/, ''), status: (s === 'running' ? 'running' : 'offline') as 'running' | 'offline' };
      });
    },

    async stats(id: string): Promise<VpsStats> {
      const hit = statCache.get(id);
      if (hit && Date.now() - hit.at < 3000) return hit.val;
      const st = await self.inspect(id);
      let val: VpsStats;
      if (st.status !== 'running') val = { ...st, cpuPct: 0, ramUsedMb: 0, diskUsedMb: 0, netRxMb: 0, netTxMb: 0 };
      else {
        const r = await run(['stats', '--no-stream', '--format', '{{json .}}', name(id)], { soft: true, timeout: 15_000 });
        let j: any = {}; try { j = JSON.parse(r.text); } catch { /* ignore */ }
        const [rx, tx] = String(j.NetIO || '').split('/');
        const df = await run(['exec', name(id), 'df', '-Pk', '/'], { soft: true });
        const used = Number((df.text.split('\n')[1] || '').split(/\s+/)[2] || 0) / 1024;
        val = {
          ...st, cpuPct: parseFloat(j.CPUPerc) || 0, ramUsedMb: Math.round(mb((j.MemUsage || '').split('/')[0])),
          diskUsedMb: Math.round(used), netRxMb: +mb(rx).toFixed(1), netTxMb: +mb(tx).toFixed(1),
        };
      }
      statCache.set(id, { at: Date.now(), val });
      return val;
    },

    async logs(id: string, tail = 300): Promise<string> {
      const r = await run(['logs', '--tail', String(Math.min(2000, tail)), '--timestamps', name(id)], { soft: true });
      return stripAnsi(r.text + r.err);
    },

    async exec(id: string, cmd: string, cwd = '/root'): Promise<VpsExecResult> {
      const script = `${cmd}\n__rc=$?; printf '\\n__MONO_END__%s\\n%s' "$__rc" "$PWD"`;
      const r = await run(['exec', '-w', safePath(cwd), name(id), 'bash', '-c', script], { soft: true, timeout: 30_000 });
      const full = stripAnsi((r.text + r.err).slice(0, 262144));
      const i = full.lastIndexOf('\n__MONO_END__');
      if (i < 0) return { output: full || 'Command failed or timed out (30s limit). Use SSH or sshx for long-running programs.', code: r.code || 1, cwd };
      const [rc, pwd] = full.slice(i + 13).split('\n');
      return { output: full.slice(0, i), code: Number(rc) || 0, cwd: pwd || cwd };
    },

    async list(id: string, p: string): Promise<VpsFileEntry[]> {
      const d = safePath(p);
      const r = await run(['exec', name(id), 'find', d, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%s\\t%T@\\t%f\\0']);
      return r.text.split('\0').filter(Boolean).map(l => {
        const [t, s, m, ...n] = l.split('\t');
        const modified = Math.round(Number(m) * 1000);
        return { name: n.join('\t'), dir: t === 'd', link: t === 'l', size: Number(s) || 0, modified: Number.isFinite(modified) ? modified : 0 };
      }).filter(f => f.name).sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
    },

    async read(id: string, p: string): Promise<string> {
      const f = safePath(p);
      const sz = Number((await run(['exec', name(id), 'stat', '-c', '%s', f])).text);
      if (sz > 2 * 1024 * 1024) throw new HttpError(413, 'File is larger than 2 MB. Use SSH/SFTP instead.');
      return (await run(['exec', name(id), 'cat', '--', f])).text;
    },
    async write(id: string, p: string, content: string): Promise<void> { await run(['exec', '-i', name(id), 'sh', '-c', 'cat > "$1"', 'sh', safePath(p)], { input: content }); },
    async mkdir(id: string, p: string): Promise<void> { await run(['exec', name(id), 'mkdir', '-p', '--', safePath(p)]); },
    async remove(id: string, p: string): Promise<void> {
      const f = safePath(p);
      if (f === '/') throw new HttpError(400, 'Refusing to delete /');
      await run(['exec', name(id), 'rm', '-rf', '--', f]);
    },
    async rename(id: string, a: string, b: string): Promise<void> { await run(['exec', name(id), 'mv', '--', safePath(a), safePath(b)]); },
    setPassword,

    async sshx(id: string, action: 'start' | 'stop' | 'status'): Promise<VpsSshx> {
      const c = name(id), log = '/tmp/sshx.log';
      // "-x" matches the process NAME exactly. "pkill -f sshx" would also match the wrapping `sh -c '... sshx ...'` and kill it before the log was removed.
      const kill = 'pkill -x sshx; rm -f /tmp/sshx.log; true';
      if (action === 'stop') { await run(['exec', c, 'sh', '-c', kill], { soft: true }); return { running: false, url: null }; }
      if (action === 'start') {
        await run(['exec', c, 'sh', '-c', kill], { soft: true });
        await run(['exec', '-d', c, 'sh', '-c', `curl -sSf https://sshx.io/get | sh -s run > ${log} 2>&1`], { soft: true });
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const u = await self.sshx(id, 'status');
          if (u.url) return u;
        }
        throw new HttpError(504, 'sshx did not return a link. Does the VPS have internet access?');
      }
      const r = await run(['exec', c, 'cat', log], { soft: true });
      const alive = (await run(['exec', c, 'pgrep', '-x', 'sshx'], { soft: true })).code === 0;
      const m = /https:\/\/sshx\.io\/s\/[^\s]+/.exec(stripAnsi(r.text));
      return { running: !!m && alive, url: m && alive ? m[0] : null };
    },

    async destroy(id: string): Promise<void> { await run(['rm', '-f', '-v', name(id)], { soft: true }); statCache.delete(id); },
    async reinstall(v: VpsSpec) { await self.destroy(v.id); return self.create(v); },
  };
  return self;
}
