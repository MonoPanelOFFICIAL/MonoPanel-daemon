import http, { IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import tls from 'tls';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { log } from './log';
import { HttpError } from './safe';
import { kindEnabled } from './kinds';
import { ServerSpec } from './runtime/types';
import * as store from './state';
import { getRuntime } from './runtime';

/**
 * Website hosting: a small, dependency-free reverse proxy built into the daemon.
 *
 *   browser --(Host: shop.example.com)--> WEB_HTTP_PORT / WEB_HTTPS_PORT --> 127.0.0.1:<the customer app's port>
 *
 * The panel decides which domains belong to which server (it verifies DNS first) and pushes them in the server spec, so this
 * proxy only has to look the Host header up. Nothing is routed that the panel did not send. It is OFF unless WEB_HTTP_PORT or
 * WEB_HTTPS_PORT is set, because ports 80/443 are usually owned by something else (Caddy, nginx, Cloudflare Tunnel...), and in
 * that case you simply point that front proxy at the same app ports instead.
 *
 * HTTPS: put certificates in WEB_CERT_DIR as <domain>/fullchain.pem + <domain>/privkey.pem (exactly what certbot keeps in
 * /etc/letsencrypt/live). `_wildcard.<parent domain>/` serves every subdomain of that parent. Challenge files for certbot's
 * webroot mode are served from WEB_ACME_DIR at /.well-known/acme-challenge/.
 */

export interface WebDeps {
  /** Spec for a host name, or null. */
  lookup(host: string): ServerSpec | null;
  /** Is the customer's process running right now? */
  isRunning(spec: ServerSpec): Promise<boolean>;
  hasCert(host: string): boolean;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const validDomain = (d: unknown): d is string => typeof d === 'string' && HOST_RE.test(d);

/** `Host` header -> bare lower-case name (port removed). Returns '' for anything that is not a plain DNS name. */
export function hostOf(header: string | undefined): string {
  const h = String(header || '').toLowerCase().trim().replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  return validDomain(h) ? h : '';
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function page(res: ServerResponse, status: number, title: string, text: string): void {
  if (res.headersSent) { res.end(); return; }
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font:15px/1.5 system-ui,sans-serif"><main style="text-align:center;padding:24px;max-width:460px">`
    + `<p style="font:600 12px ui-monospace,monospace;letter-spacing:.15em;color:#71717a">${status}</p><h1 style="margin:.4em 0;font-size:22px">${esc(title)}</h1><p style="color:#a1a1aa;margin:0">${esc(text)}</p></main></body>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);

function clientAddress(req: IncomingMessage): string {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fwd = String(req.headers['x-forwarded-for'] || '');
  // Only believe X-Forwarded-For when the connection comes from a proxy the owner listed (Cloudflare tunnel, nginx...).
  if (fwd && config.web.trustProxy.includes(peer)) return fwd.split(',')[0].trim() || peer;
  return peer;
}

function upstreamHeaders(req: IncomingMessage, proto: 'http' | 'https', keepUpgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP.has(key) && !(keepUpgrade && (key === 'upgrade' || key === 'connection'))) continue;
    if (key === 'x-forwarded-for' || key === 'x-forwarded-proto' || key === 'x-forwarded-host' || key === 'x-real-ip') continue; // never pass on values a visitor made up
    out[k] = v;
  }
  const ip = clientAddress(req);
  out['x-forwarded-for'] = ip; out['x-real-ip'] = ip; out['x-forwarded-proto'] = proto; out['x-forwarded-host'] = String(req.headers.host || '');
  return out;
}

export function makeHandlers(deps: WebDeps) {
  const route = (req: IncomingMessage): { host: string; spec: ServerSpec | null; port: number } => {
    const host = hostOf(req.headers.host);
    const spec = host && kindEnabled('website') ? deps.lookup(host) : null;
    return { host, spec, port: spec?.ports[0]?.host || 0 };
  };

  function acme(req: IncomingMessage, res: ServerResponse): boolean {
    const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{10,128})$/.exec((req.url || '').split('?')[0]);
    if (!m) return false;
    const file = path.join(config.web.acmeDir, m[1]);
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { page(res, 404, 'Not found', 'No such challenge.'); }
    return true;
  }

  async function request(req: IncomingMessage, res: ServerResponse, proto: 'http' | 'https'): Promise<void> {
    if (proto === 'http' && acme(req, res)) return;
    const { host, spec, port } = route(req);
    if (!spec || !port) return page(res, 404, 'No site here', 'This address is not connected to a website.');
    if (proto === 'http' && config.web.forceHttps && config.web.httpsPort && deps.hasCert(host)) {
      const p = config.web.httpsPort === 443 ? '' : `:${config.web.httpsPort}`;
      res.writeHead(301, { Location: `https://${host}${p}${req.url || '/'}`, 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (!(await deps.isRunning(spec).catch(() => false))) return page(res, 503, 'This site is offline', 'The owner has stopped it or it is starting up. Try again in a moment.');

    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req, proto, false), timeout: 60_000 }, ures => {
      const h: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ures.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(ures.statusCode || 502, h);
      ures.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => page(res, 502, 'The site did not answer', 'The app is running but is not responding on its port. If this is your site, check its console.'));
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  function upgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): void {
    const { spec, port } = route(req);
    const fail = () => { try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch { /* gone */ } };
    if (!spec || !port) return fail();
    const up = net.connect(port, '127.0.0.1');
    up.setTimeout(30_000, () => up.destroy());
    up.on('connect', () => {
      up.setTimeout(0);
      const h = upstreamHeaders(req, (socket as any).encrypted ? 'https' : 'http', true);
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : [v]) raw += `${k}: ${String(x).replace(/[\r\n]/g, ' ')}\r\n`;
      up.write(raw + '\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', fail);
    socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
  }
  return { request, upgrade };
}

// ------------------------------------------------------------------------------------------------ certificates
const certCache = new Map<string, { ctx: tls.SecureContext | null; at: number }>();
const CERT_TTL = 10 * 60_000;

function certFiles(host: string): { cert: string; key: string } | null {
  if (!config.web.certDir) return null;
  const parent = host.split('.').slice(1).join('.');
  for (const dir of [host, parent ? `_wildcard.${parent}` : '']) {
    if (!dir) continue;
    const base = path.join(config.web.certDir, dir);
    const cert = path.join(base, 'fullchain.pem'), key = path.join(base, 'privkey.pem');
    if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  }
  return null;
}

export function contextFor(host: string): tls.SecureContext | null {
  const hit = certCache.get(host);
  if (hit && Date.now() - hit.at < (hit.ctx ? CERT_TTL : 30_000)) return hit.ctx;
  let ctx: tls.SecureContext | null = null;
  const f = certFiles(host);
  if (f) { try { ctx = tls.createSecureContext({ cert: fs.readFileSync(f.cert), key: fs.readFileSync(f.key) }); } catch (e: any) { log.warn(`Could not load the certificate for ${host}: ${e?.message}`); } }
  certCache.set(host, { ctx, at: Date.now() });
  return ctx;
}
export const hasCert = (host: string): boolean => !!contextFor(host);

// ------------------------------------------------------------------------------------------------ domain index
let index: { at: number; map: Map<string, ServerSpec> } | null = null;
export function invalidateDomains(): void { index = null; }
function domainMap(): Map<string, ServerSpec> {
  if (index && Date.now() - index.at < 3000) return index.map;
  const map = new Map<string, ServerSpec>();
  for (const s of store.listSpecs()) for (const d of s.domains || []) if (!map.has(d)) map.set(d, s);   // first server wins; the panel never sends a clash
  index = { at: Date.now(), map };
  return map;
}

/** Domains are checked again here: the panel is trusted, but a bad list must never reach the Host-header lookup. */
export function validateDomains(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 12) throw new HttpError(400, 'Invalid domains');
  const out = [...new Set(v.map(x => String(x).toLowerCase().trim()))];
  for (const d of out) if (!validDomain(d)) throw new HttpError(400, `Invalid domain: ${String(d).slice(0, 80)}`);
  return out;
}

const runningCache = new Map<string, { at: number; up: boolean }>();
async function isRunning(spec: ServerSpec): Promise<boolean> {
  const hit = runningCache.get(spec.id);
  if (hit && Date.now() - hit.at < 2000) return hit.up;
  const up = (await (await getRuntime()).state(spec.id)).state === 'running';
  runningCache.set(spec.id, { at: Date.now(), up });
  if (runningCache.size > 5000) runningCache.clear();
  return up;
}

export interface WebStatus { enabled: boolean; httpPort: number; httpsPort: number; domains: number; certs: number }
let started: { http?: http.Server; https?: https.Server } = {};

export function webStatus(): WebStatus {
  const map = domainMap();
  return { enabled: !!(started.http || started.https), httpPort: started.http ? config.web.httpPort : 0, httpsPort: started.https ? config.web.httpsPort : 0, domains: map.size, certs: [...map.keys()].filter(d => !!certFiles(d)).length };
}

/** Starts the proxy when WEB_HTTP_PORT / WEB_HTTPS_PORT are set and this node serves websites. */
export function startWebProxy(): void {
  const { httpPort, httpsPort, host, acmeDir } = config.web;
  if (!kindEnabled('website')) return;
  if (!httpPort && !httpsPort) { log.info('Website proxy is off (set WEB_HTTP_PORT / WEB_HTTPS_PORT to let this node serve domains itself)'); return; }
  fs.mkdirSync(acmeDir, { recursive: true, mode: 0o755 });
  const h = makeHandlers({ lookup: d => domainMap().get(d) || null, isRunning, hasCert });
  const tune = (s: http.Server | https.Server) => { s.headersTimeout = 20_000; s.requestTimeout = 0; s.maxHeadersCount = 60; s.keepAliveTimeout = 30_000; };
  const onError = (label: string) => (e: any) => log.error(`Website proxy (${label}) failed: ${e?.code === 'EACCES' ? 'permission denied: ports below 1024 need root or `setcap cap_net_bind_service=+ep $(which node)`' : e?.message}`);

  if (httpPort) {
    const s = http.createServer((q, r) => { void h.request(q, r, 'http'); });
    tune(s); s.on('upgrade', h.upgrade); s.on('error', onError('http'));
    s.listen(httpPort, host, () => log.info(`Website proxy listening on http://${host}:${httpPort}`));
    started.http = s;
  }
  if (httpsPort) {
    const s = https.createServer({
      minVersion: 'TLSv1.2',
      SNICallback: (name, cb) => {
        const n = hostOf(name);
        const ctx = n && domainMap().has(n) ? contextFor(n) : null;
        cb(ctx ? null : new Error('no certificate'), ctx || undefined);
      },
    }, (q, r) => { void h.request(q, r, 'https'); });
    tune(s); s.on('upgrade', h.upgrade); s.on('error', onError('https'));
    s.listen(httpsPort, host, () => log.info(`Website proxy listening on https://${host}:${httpsPort} (certificates from ${config.web.certDir})`));
    started.https = s;
  }
}

export function stopWebProxy(): void { started.http?.close(); started.https?.close(); started = {}; }
