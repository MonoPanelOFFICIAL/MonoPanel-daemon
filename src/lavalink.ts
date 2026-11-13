import fs from 'fs';
import path from 'path';
import { HttpError, resolveInVolume } from './safe';
import { ServerSpec } from './runtime/types';
import * as fsops from './fsops';

/**
 * Lavalink hosting. A Lavalink server is a Java app that reads ./application.yml. This module
 *  - generates application.yml from a small, validated settings object (so customers never hand-edit YAML for the common cases),
 *  - keeps those settings next to it (.mono-lavalink.json) so the panel can show and change them again later,
 *  - lets advanced users switch to the raw file (managed = false), and
 *  - asks the running Lavalink for its version / players / memory so the panel can show a live status.
 *
 * The password and the port are NOT written into the file: they stay placeholders (${LAVALINK_PASSWORD}, ${SERVER_PORT}) that
 * Spring resolves from the environment the daemon starts the server with. Changing the password in the panel therefore
 * only needs a restart, and a node that moves the server to another port never leaves a stale value behind.
 */

export const YML_FILE = 'application.yml';
export const SETTINGS_FILE = '.mono-lavalink.json';
export const HEADER = '# Managed by MonoPanel. Change these settings from the Lavalink tab of your server, or switch to raw mode there to edit this file yourself.';

const SOURCES = ['youtube', 'bandcamp', 'soundcloud', 'twitch', 'vimeo', 'nico', 'http', 'local'] as const;
const FILTERS = ['volume', 'equalizer', 'karaoke', 'timescale', 'tremolo', 'vibrato', 'distortion', 'rotation', 'channelMix', 'lowPass'] as const;
const QUALITY = ['LOW', 'MEDIUM', 'HIGH'] as const;
const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'] as const;

export interface LavalinkPlugin { dependency: string; repository?: string; snapshot?: boolean }
export interface LavalinkSettings {
  sources: Record<typeof SOURCES[number], boolean>;
  filters: Record<typeof FILTERS[number], boolean>;
  bufferDurationMs: number;
  frameBufferDurationMs: number;
  opusEncodingQuality: number;
  resamplingQuality: typeof QUALITY[number];
  trackStuckThresholdMs: number;
  useSeekGhosting: boolean;
  playerUpdateInterval: number;
  youtubePlaylistLoadLimit: number;
  gcWarnings: boolean;
  metrics: boolean;
  logLevel: typeof LEVELS[number];
  plugins: LavalinkPlugin[];
  /** Appended to the end of the file. This is where plugin settings live (the top-level `plugins:` block). */
  extraYaml: string;
}

export function defaultSettings(): LavalinkSettings {
  return {
    sources: { youtube: false, bandcamp: true, soundcloud: true, twitch: true, vimeo: true, nico: true, http: true, local: false },
    filters: { volume: true, equalizer: true, karaoke: true, timescale: true, tremolo: true, vibrato: true, distortion: true, rotation: true, channelMix: true, lowPass: true },
    bufferDurationMs: 400, frameBufferDurationMs: 5000, opusEncodingQuality: 10, resamplingQuality: 'LOW',
    trackStuckThresholdMs: 10000, useSeekGhosting: true, playerUpdateInterval: 5, youtubePlaylistLoadLimit: 6,
    gcWarnings: true, metrics: false, logLevel: 'INFO', plugins: [], extraYaml: '',
  };
}

const num = (v: unknown, min: number, max: number, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

/** group:artifact:version, as Lavalink expects it. No spaces, quotes or YAML control characters can get through. */
const COORD = /^[A-Za-z0-9_.-]{1,100}:[A-Za-z0-9_.-]{1,100}:[A-Za-z0-9_.+-]{1,80}$/;
const REPO = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{4,300}$/;

/** Validates user input against the defaults. Unknown keys are dropped, bad values fall back, nothing is trusted. */
export function sanitize(input: any, prev: LavalinkSettings = defaultSettings()): LavalinkSettings {
  const i = input && typeof input === 'object' ? input : {};
  const d = prev;
  const sources = { ...d.sources }, filters = { ...d.filters };
  for (const k of SOURCES) sources[k] = bool(i.sources?.[k], d.sources[k]);
  for (const k of FILTERS) filters[k] = bool(i.filters?.[k], d.filters[k]);

  let plugins = d.plugins;
  if (i.plugins !== undefined) {
    if (!Array.isArray(i.plugins) || i.plugins.length > 20) throw new HttpError(400, 'At most 20 plugins');
    plugins = i.plugins.map((p: any) => {
      const dependency = String(p?.dependency || '').trim();
      if (!COORD.test(dependency)) throw new HttpError(400, `Plugin "${dependency.slice(0, 60)}" must look like group:artifact:version`);
      const out: LavalinkPlugin = { dependency };
      const repo = String(p?.repository || '').trim();
      if (repo) { if (!REPO.test(repo)) throw new HttpError(400, 'Plugin repository must be an https:// URL'); out.repository = repo; }
      if (p?.snapshot === true) out.snapshot = true;
      return out;
    });
  }
  let extraYaml = d.extraYaml;
  if (i.extraYaml !== undefined) {
    extraYaml = String(i.extraYaml).replace(/\r\n?/g, '\n');
    if (extraYaml.length > 20_000 || /[\0]/.test(extraYaml)) throw new HttpError(400, 'Extra YAML is too long or contains invalid characters');
    if (/^(server|lavalink|metrics|logging)\s*:/m.test(extraYaml)) {
      throw new HttpError(400, 'Extra YAML cannot redefine server:, lavalink:, metrics: or logging:. Those come from the settings above (or use raw mode).');
    }
  }
  return {
    sources, filters,
    bufferDurationMs: num(i.bufferDurationMs, 50, 5000, d.bufferDurationMs),
    frameBufferDurationMs: num(i.frameBufferDurationMs, 1000, 30000, d.frameBufferDurationMs),
    opusEncodingQuality: num(i.opusEncodingQuality, 0, 10, d.opusEncodingQuality),
    resamplingQuality: (QUALITY as readonly string[]).includes(i.resamplingQuality) ? i.resamplingQuality : d.resamplingQuality,
    trackStuckThresholdMs: num(i.trackStuckThresholdMs, 1000, 120000, d.trackStuckThresholdMs),
    useSeekGhosting: bool(i.useSeekGhosting, d.useSeekGhosting),
    playerUpdateInterval: num(i.playerUpdateInterval, 1, 60, d.playerUpdateInterval),
    youtubePlaylistLoadLimit: num(i.youtubePlaylistLoadLimit, 1, 100, d.youtubePlaylistLoadLimit),
    gcWarnings: bool(i.gcWarnings, d.gcWarnings),
    metrics: bool(i.metrics, d.metrics),
    logLevel: (LEVELS as readonly string[]).includes(i.logLevel) ? i.logLevel : d.logLevel,
    plugins, extraYaml,
  };
}

const q = (s: string): string => JSON.stringify(s);   // a JSON string is a valid double-quoted YAML scalar

/** The exact application.yml for these settings. Pure function: easy to test. */
export function renderYaml(s: LavalinkSettings): string {
  const L: string[] = [HEADER, 'server:', '  port: ${SERVER_PORT:2333}', '  address: 0.0.0.0', '  http2:', '    enabled: false', 'metrics:', '  prometheus:', `    enabled: ${s.metrics}`, '    endpoint: /metrics', 'lavalink:'];
  if (s.plugins.length) {
    L.push('  plugins:');
    for (const p of s.plugins) {
      L.push(`    - dependency: ${q(p.dependency)}`);
      if (p.repository) L.push(`      repository: ${q(p.repository)}`);
      if (p.snapshot) L.push('      snapshot: true');
    }
  }
  L.push('  server:', '    password: "${LAVALINK_PASSWORD:youshallnotpass}"', '    sources:');
  for (const k of SOURCES) L.push(`      ${k}: ${s.sources[k]}`);
  L.push('    filters:');
  for (const k of FILTERS) L.push(`      ${k}: ${s.filters[k]}`);
  L.push(
    `    bufferDurationMs: ${s.bufferDurationMs}`, `    frameBufferDurationMs: ${s.frameBufferDurationMs}`,
    `    opusEncodingQuality: ${s.opusEncodingQuality}`, `    resamplingQuality: ${s.resamplingQuality}`,
    `    trackStuckThresholdMs: ${s.trackStuckThresholdMs}`, `    useSeekGhosting: ${s.useSeekGhosting}`,
    `    youtubePlaylistLoadLimit: ${s.youtubePlaylistLoadLimit}`, `    playerUpdateInterval: ${s.playerUpdateInterval}`,
    `    gc-warnings: ${s.gcWarnings}`,
    'logging:', '  file:', '    path: ./logs/', '  level:', `    root: ${s.logLevel}`, `    lavalink: ${s.logLevel}`,
  );
  let out = L.join('\n') + '\n';
  if (s.extraYaml.trim()) out += '\n# --- extra settings (plugins) ---\n' + s.extraYaml.replace(/\s+$/, '') + '\n';
  return out;
}

// ------------------------------------------------------------------------------------------------ files
const quotaMB = (spec: ServerSpec) => spec.limits.diskMB;

function readJson(id: string): LavalinkSettings | null {
  try {
    const p = resolveInVolume(id, '/' + SETTINGS_FILE);
    if (!fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) return null;
    return sanitize(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch { return null; }
}

export interface LavalinkConfigView { managed: boolean; settings: LavalinkSettings; raw: string; exists: boolean }

export function readConfig(id: string): LavalinkConfigView {
  const settings = readJson(id);
  let raw = '', exists = false;
  try { raw = fsops.readText(id, '/' + YML_FILE); exists = true; } catch { /* no file yet: the installer has not finished */ }
  // Managed = we wrote the file (it carries our header), or nothing exists yet. A file without the header was edited in raw mode.
  return { managed: !exists || raw.startsWith(HEADER), settings: settings || defaultSettings(), raw, exists };
}

export function writeSettings(spec: ServerSpec, input: unknown): LavalinkConfigView {
  const cur = readJson(spec.id) || defaultSettings();
  const next = sanitize(input, cur);
  fsops.writeText(spec.id, '/' + YML_FILE, renderYaml(next), quotaMB(spec));
  fsops.writeText(spec.id, '/' + SETTINGS_FILE, JSON.stringify(next, null, 2), quotaMB(spec));
  return readConfig(spec.id);
}

/** Raw mode: the customer owns application.yml. The generated-settings file is removed so the panel stops claiming to manage it. */
export function writeRaw(spec: ServerSpec, content: unknown): LavalinkConfigView {
  const text = String(content ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim() || text.length > 200_000 || text.includes('\0')) throw new HttpError(400, 'application.yml is empty, too large or contains invalid characters');
  fsops.writeText(spec.id, '/' + YML_FILE, text, quotaMB(spec));
  try { const p = resolveInVolume(spec.id, '/' + SETTINGS_FILE); if (fs.existsSync(p)) fs.rmSync(p); } catch { /* ignore */ }
  return readConfig(spec.id);
}

/** Back to the managed defaults (keeps nothing of the old file). */
export function resetConfig(spec: ServerSpec): LavalinkConfigView { return writeSettings(spec, defaultSettings()); }

// ------------------------------------------------------------------------------------------------ live status
export interface LavalinkStatus {
  online: boolean;
  error?: string;
  version?: string;
  sources?: string[];
  plugins?: { name: string; version: string }[];
  stats?: { players: number; playingPlayers: number; uptimeMs: number; memUsedMB: number; memAllocatedMB: number; cpuCores: number; systemLoad: number; lavalinkLoad: number };
}

/** Asks the Lavalink running on this node (127.0.0.1:<host port>) for /v4/info and /v4/stats using the server's own password. */
export async function probe(spec: ServerSpec, fetchImpl: typeof fetch = fetch): Promise<LavalinkStatus> {
  const port = spec.ports[0]?.host;
  if (!port) return { online: false, error: 'No port assigned' };
  const password = spec.env.LAVALINK_PASSWORD || 'youshallnotpass';
  const base = `http://127.0.0.1:${port}`;
  const get = async (p: string) => {
    const r = await fetchImpl(base + p, { headers: { Authorization: password }, signal: AbortSignal.timeout(3000) });
    if (r.status === 401 || r.status === 403) throw new Error('Lavalink rejected the password. Restart the server after changing it.');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  try {
    const [info, stats] = await Promise.all([get('/v4/info'), get('/v4/stats')]);
    const mb = (b: unknown) => Math.round(Number(b || 0) / 1048576);
    return {
      online: true,
      version: String(info?.version?.semver || ''),
      sources: Array.isArray(info?.sourceManagers) ? info.sourceManagers.map(String).slice(0, 40) : [],
      plugins: Array.isArray(info?.plugins) ? info.plugins.slice(0, 40).map((p: any) => ({ name: String(p?.name || ''), version: String(p?.version || '') })) : [],
      stats: {
        players: Number(stats?.players || 0), playingPlayers: Number(stats?.playingPlayers || 0), uptimeMs: Number(stats?.uptime || 0),
        memUsedMB: mb(stats?.memory?.used), memAllocatedMB: mb(stats?.memory?.allocated), cpuCores: Number(stats?.cpu?.cores || 0),
        systemLoad: Number(stats?.cpu?.systemLoad || 0), lavalinkLoad: Number(stats?.cpu?.lavalinkLoad || 0),
      },
    };
  } catch (e: any) {
    const code = e?.cause?.code || e?.code;
    return { online: false, error: code === 'ECONNREFUSED' || e?.name === 'TimeoutError' ? 'Lavalink is not answering yet (is the server running?)' : String(e?.message || 'unreachable').slice(0, 200) };
  }
}

/** Files that can be listed under plugins/ so the panel can show what Lavalink downloaded. */
export function listPluginJars(id: string): { name: string; size: number }[] {
  try {
    const dir = resolveInVolume(id, '/plugins');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && !d.isSymbolicLink() && d.name.endsWith('.jar'))
      .map(d => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }));
  } catch { return []; }
}
