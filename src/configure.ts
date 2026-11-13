import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Usage: npm run configure -- --panel https://panel.example.com --key <secret> [--port 3002] [--allow 1.2.3.4] [--sftp 2022] [--vps auto|docker|mock|off] [--database postgres://user:pass@host:5432/db]
 *        [--services bot,nodejs,website,lavalink,vps] [--web-http 80] [--web-https 443] [--cert-dir /etc/letsencrypt/live]
 * The panel shows this exact command after you add the node (Admin > Nodes or Admin > VPS Nodes: both use this one daemon).
 * The secret is written to .env with mode 600 (never echoed back).
 */
function arg(name: string, short?: string): string {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if ((a[i] === `--${name}` || (short && a[i] === `-${short}`)) && a[i + 1]) return a[i + 1];
  return '';
}

async function main(): Promise<void> {
  const panel = arg('panel', 'p').replace(/\/+$/, '');
  const key = arg('key', 'k');
  if (!panel || !key) { console.error('Usage: npm run configure -- --panel <url> --key <secret> [--port 3002] [--allow <panel-ip>] [--services bot,nodejs,website,lavalink,vps] [--web-http 80 --web-https 443 --cert-dir <dir>]'); process.exit(1); }
  if (key.length < 32) { console.error('The secret from the panel must be at least 32 characters.'); process.exit(1); }
  try {
    const r = await fetch(`${panel}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    console.log('Panel reachable.');
  } catch (e: any) { console.warn(`Warning: could not reach the panel (${e.message}). Continuing, the daemon does not need outbound access to it.`); }

  const file = path.join(process.cwd(), '.env');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
  const set = (src: string, k: string, v: string) => (new RegExp(`^${k}=.*$`, 'm').test(src) ? src.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${src.trimEnd()}\n${k}=${v}\n`);
  let out = set(existing, 'DAEMON_SECRET', key);
  const port = arg('port'); if (port) out = set(out, 'DAEMON_PORT', port);
  const allow = arg('allow'); if (allow) out = set(out, 'ALLOWED_IPS', allow);
  const database = arg('database', 'd');
  if (database) {
    if (!/^postgres(ql)?:\/\//i.test(database)) { console.error('--database must be a PostgreSQL URL: postgres://user:password@host:5432/dbname'); process.exit(1); }
    out = set(out, 'DATABASE_URL', database);
  }
  const sftp = arg('sftp'); if (sftp) out = set(out, 'SFTP_PORT', sftp);
  const vps = arg('vps').toLowerCase();
  if (vps) {
    if (!['auto', 'docker', 'mock', 'off'].includes(vps)) { console.error('--vps must be one of: auto, docker, mock, off'); process.exit(1); }
    out = set(out, 'VPS_RUNTIME', vps);
  }
  // Which kinds of hosting this node serves, and the website proxy ports. All optional: omit them and the node serves everything, proxy off.
  const services = arg('services').toLowerCase().replace(/\s+/g, '');
  if (services) {
    const all = ['bot', 'nodejs', 'website', 'lavalink', 'vps'];
    const bad = services.split(',').filter(x => x && !all.includes(x));
    if (bad.length) { console.error(`--services: unknown ${bad.join(', ')}. Use any of: ${all.join(', ')}`); process.exit(1); }
    out = set(out, 'NODE_SERVICES', services);
  }
  for (const [flag, envKey] of [['web-http', 'WEB_HTTP_PORT'], ['web-https', 'WEB_HTTPS_PORT']] as const) {
    const v = arg(flag);
    if (!v) continue;
    if (!/^\d{1,5}$/.test(v) || +v < 1 || +v > 65535) { console.error(`--${flag} must be a port number`); process.exit(1); }
    out = set(out, envKey, v);
  }
  const certDir = arg('cert-dir'); if (certDir) out = set(out, 'WEB_CERT_DIR', certDir);
  if (!/^DATABASE_URL=postgres/im.test(out)) console.warn('Note: DATABASE_URL is not set yet. The daemon stores its state in PostgreSQL: add it to .env (or re-run with --database postgres://...) before starting.');
  fs.writeFileSync(file, out, { mode: 0o600 });
  console.log(`Wrote ${file} (fingerprint ${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}). Start the daemon with: npm start`);
}
main();
