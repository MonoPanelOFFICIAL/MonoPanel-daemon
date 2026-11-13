import fs from 'fs';
import path from 'path';
import { HttpError, resolveInVolume, volumePath } from './safe';
import { ServerSpec } from './runtime/types';
import { getRuntime } from './runtime';
import * as fsops from './fsops';

/**
 * Node.js (and full-stack website) hosting helpers on top of the normal server engine.
 *
 *  - `project()` reads package.json / lockfiles / .git so the panel can show what is deployed and which scripts exist.
 *  - `runTask()` runs ONE fixed, reviewed shell script (install, build, update, clean) in a throw-away container made from the
 *    server's own image (or natively on the process runtime). Customers pick a task by name; they can never send their own
 *    command through this route (the console and Startup tab already cover that, inside the server's own limits).
 */

export type TaskName = 'install' | 'build' | 'update' | 'clean';
export const TASKS: TaskName[] = ['install', 'build', 'update', 'clean'];

export interface ProjectInfo {
  hasPackageJson: boolean;
  name?: string; version?: string; main?: string; type?: string;
  scripts: Record<string, string>;
  dependencies: number; devDependencies: number;
  engines?: Record<string, string>;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  lockfile: boolean;
  nodeModules: boolean;
  git: { present: boolean; remote?: string; branch?: string };
  envFile: boolean;
  framework?: string;
}

const PM_LOCKS: [string, ProjectInfo['packageManager']][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']];

/** Strips credentials (https://user:token@host/...) so an access token never reaches the browser. */
export function cleanRemote(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/\s]+@/i, '$1');
}

function readGit(dir: string): ProjectInfo['git'] {
  const g = path.join(dir, '.git');
  try {
    if (!fs.lstatSync(g).isDirectory()) return { present: false };
    let remote: string | undefined, branch: string | undefined;
    try { remote = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s.exec(fs.readFileSync(path.join(g, 'config'), 'utf8'))?.[1]; } catch { /* no config */ }
    try { branch = /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(g, 'HEAD'), 'utf8'))?.[1]?.trim(); } catch { /* detached */ }
    return { present: true, remote: remote ? cleanRemote(remote) : undefined, branch };
  } catch { return { present: false }; }
}

function detectFramework(deps: Record<string, unknown>): string | undefined {
  const has = (n: string) => Object.prototype.hasOwnProperty.call(deps, n);
  for (const [dep, label] of [['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@remix-run/node', 'Remix'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'], ['vite', 'Vite'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['koa', 'Koa'], ['hono', 'Hono'], ['discord.js', 'discord.js']] as const) if (has(dep)) return label;
  return undefined;
}

export function project(id: string): ProjectInfo {
  const dir = resolveInVolume(id, '/');
  const info: ProjectInfo = { hasPackageJson: false, scripts: {}, dependencies: 0, devDependencies: 0, packageManager: 'npm', lockfile: false, nodeModules: false, git: readGit(dir), envFile: false };
  const exists = (n: string) => { try { return !fs.lstatSync(path.join(dir, n)).isSymbolicLink() && fs.existsSync(path.join(dir, n)); } catch { return false; } };
  for (const [f, pm] of PM_LOCKS) if (exists(f)) { info.packageManager = pm; info.lockfile = true; break; }
  info.nodeModules = exists('node_modules');
  info.envFile = exists('.env');
  try {
    const p = path.join(dir, 'package.json');
    const st = fs.lstatSync(p);
    if (st.isFile() && st.size <= 512 * 1024) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      info.hasPackageJson = true;
      info.name = typeof j.name === 'string' ? j.name.slice(0, 214) : undefined;
      info.version = typeof j.version === 'string' ? j.version.slice(0, 40) : undefined;
      info.main = typeof j.main === 'string' ? j.main.slice(0, 200) : undefined;
      info.type = j.type === 'module' ? 'module' : 'commonjs';
      if (j.scripts && typeof j.scripts === 'object') for (const [k, v] of Object.entries(j.scripts).slice(0, 40)) if (typeof v === 'string') info.scripts[k.slice(0, 60)] = v.slice(0, 300);
      const d = j.dependencies && typeof j.dependencies === 'object' ? j.dependencies : {}, dd = j.devDependencies && typeof j.devDependencies === 'object' ? j.devDependencies : {};
      info.dependencies = Object.keys(d).length; info.devDependencies = Object.keys(dd).length;
      if (j.engines && typeof j.engines === 'object') info.engines = Object.fromEntries(Object.entries(j.engines).slice(0, 5).map(([k, v]) => [k.slice(0, 20), String(v).slice(0, 40)]));
      info.framework = detectFramework({ ...dd, ...d });
      if (typeof j.packageManager === 'string') { const pm = j.packageManager.split('@')[0]; if (['npm', 'pnpm', 'yarn', 'bun'].includes(pm) && !info.lockfile) info.packageManager = pm as ProjectInfo['packageManager']; }
    }
  } catch { /* unreadable package.json: report hasPackageJson=false */ }
  return info;
}

/** The fixed scripts. `cd /mnt/server` is rewritten to the volume on the process runtime. Package manager follows the lockfile. */
export function scriptFor(task: TaskName, pm: ProjectInfo['packageManager']): string {
  const head = 'cd /mnt/server || exit 1\nset -e\n';
  const install = {
    npm: 'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund || npm install --no-audit --no-fund; else npm install --no-audit --no-fund; fi',
    pnpm: 'corepack enable >/dev/null 2>&1 || true; pnpm install --frozen-lockfile || pnpm install',
    yarn: 'corepack enable >/dev/null 2>&1 || true; yarn install --frozen-lockfile || yarn install',
    bun: 'bun install',
  }[pm];
  const run = { npm: 'npm run build', pnpm: 'pnpm run build', yarn: 'yarn build', bun: 'bun run build' }[pm];
  switch (task) {
    case 'install': return `${head}[ -f package.json ] || { echo "No package.json in the server root."; exit 1; }\n${install}\necho "Task finished: install"`;
    // A build needs devDependencies, so it installs everything first (the start command later prunes nothing; disk use is shown in the panel).
    case 'build': return `${head}[ -f package.json ] || { echo "No package.json in the server root."; exit 1; }\n${install}\n${run}\necho "Task finished: build"`;
    case 'update': return `${head}[ -d .git ] || { echo "This server was not deployed from git (no .git folder)."; exit 1; }\ngit pull --ff-only\n[ -f package.json ] && { ${install}; }\necho "Task finished: update"`;
    case 'clean': return `${head}rm -rf node_modules .next .nuxt .cache dist\necho "Task finished: clean"`;
  }
}

export interface TaskRun { task: TaskName; state: 'running' | 'done' | 'failed'; startedAt: string; endedAt?: string; log: string[]; code?: number }
const runs = new Map<string, TaskRun>();

export function lastRun(id: string): TaskRun | null { return runs.get(id) || null; }

export async function runTask(spec: ServerSpec, task: unknown, env: Record<string, string> = {}): Promise<TaskRun> {
  if (!TASKS.includes(task as TaskName)) throw new HttpError(400, `Unknown task. Choose one of: ${TASKS.join(', ')}`);
  const t = task as TaskName;
  const cur = runs.get(spec.id);
  if (cur?.state === 'running') throw new HttpError(409, `A "${cur.task}" task is already running`);
  if (!spec.image) throw new HttpError(409, 'This server has no image yet');
  const rt = await getRuntime();
  if ((await rt.state(spec.id)).state === 'running' && t !== 'install') throw new HttpError(409, 'Stop the server before running this task (it changes files the running app is using)');

  const dir = fsops.ensureVolume(spec.id);
  const run: TaskRun = { task: t, state: 'running', startedAt: new Date().toISOString(), log: [] };
  runs.set(spec.id, run);
  const line = (l: string) => { run.log.push(l.slice(0, 400)); if (run.log.length > 200) run.log.shift(); };
  const pm = project(spec.id).packageManager;
  void (async () => {
    try {
      const code = await rt.install({ id: spec.id, dir, image: spec.image, script: scriptFor(t, pm), entrypoint: 'bash', env: { ...env, CI: 'true', npm_config_update_notifier: 'false' } }, line);
      run.code = code; run.state = code === 0 ? 'done' : 'failed';
      if (code !== 0) line(`Task exited with code ${code}`);
    } catch (e: any) { run.state = 'failed'; line(String(e?.message || e)); }
    finally { run.endedAt = new Date().toISOString(); await fsops.chownTree(volumePath(spec.id)); }
  })();
  return run;
}

export function forget(id: string): void { runs.delete(id); }
