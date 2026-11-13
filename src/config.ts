import fs from 'fs';
import path from 'path';

/** Tiny .env reader so the daemon needs zero runtime dependencies. */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(process.cwd(), '.env'));

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const int = (k: string, d: number): number => {
  const n = parseInt(env(k), 10);
  return Number.isFinite(n) ? n : d;
};

const dataDir = path.resolve(env('DATA_DIR', './data'));

/** Kinds of hosting this node serves. Keep in sync with KINDS in kinds.ts (not imported here to avoid a cycle). */
const ALL_KINDS = ['bot', 'nodejs', 'website', 'lavalink', 'vps'];
const servicesRaw = env('NODE_SERVICES', ALL_KINDS.join(','));
const services = ALL_KINDS.filter(k => servicesRaw.split(',').map(s => s.trim().toLowerCase()).includes(k));

export const config = {
  secret: env('DAEMON_SECRET'),
  host: env('DAEMON_HOST', '0.0.0.0'),
  port: int('DAEMON_PORT', 3002),
  allowedIps: env('ALLOWED_IPS').split(',').map(s => s.trim()).filter(Boolean),
  tlsCert: env('TLS_CERT'),
  tlsKey: env('TLS_KEY'),
  runtime: env('RUNTIME', 'auto').toLowerCase() as 'auto' | 'docker' | 'podman' | 'process',
  socket: env('CONTAINER_SOCKET', process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),
  ociRuntime: env('OCI_RUNTIME'),
  processSandbox: env('PROCESS_SANDBOX', 'auto').toLowerCase() as 'auto' | 'bwrap' | 'none',
  dataDir,
  volumesDir: path.resolve(env('VOLUMES_DIR', path.join(dataDir, 'volumes'))),
  backupsDir: path.resolve(env('BACKUPS_DIR', path.join(dataDir, 'backups'))),
  portMin: int('PORT_MIN', 20000),
  portMax: int('PORT_MAX', 40000),
  uid: int('CONTAINER_UID', 1000),
  gid: int('CONTAINER_GID', 1000),
  imagePrefixes: env('ALLOWED_IMAGE_PREFIXES').split(',').map(s => s.trim()).filter(Boolean),
  allowPrivateDownloads: env('ALLOW_PRIVATE_DOWNLOADS') === 'true',
  sftpPort: int('SFTP_PORT', 0),               // 0 = SFTP disabled
  sftpHostKey: env('SFTP_HOST_KEY', path.join(dataDir, 'sftp_host_key.pem')),
  maxTransferMB: int('MAX_TRANSFER_MB', 20480),
  // PostgreSQL: the daemon's only database (server definitions, installer progress, recycle bin index).
  database: {
    url: env('DATABASE_URL'),
    ssl: env('DATABASE_SSL').toLowerCase(),
    sslCa: env('DATABASE_SSL_CA'),
    poolMax: Math.max(1, Math.min(20, int('DATABASE_POOL_MAX', 3))),
    prefix: env('DATABASE_TABLE_PREFIX') || 'daemon_',
  },
  /** Hosting kinds this node serves (NODE_SERVICES). Default: all. */
  services,
  servicesRaw,
  // Website hosting: built-in reverse proxy that routes a Host name to a customer's app. 0 = proxy off.
  web: {
    httpPort: int('WEB_HTTP_PORT', 0),
    httpsPort: int('WEB_HTTPS_PORT', 0),
    host: env('WEB_HOST', '0.0.0.0'),
    /** Folder with <domain>/fullchain.pem + <domain>/privkey.pem (the layout certbot uses in /etc/letsencrypt/live). */
    certDir: env('WEB_CERT_DIR'),
    /** Served at /.well-known/acme-challenge/ so `certbot certonly --webroot -w <this folder>` works. */
    acmeDir: path.resolve(env('WEB_ACME_DIR', path.join(dataDir, 'acme'))),
    /** Redirect plain HTTP to HTTPS for domains that have a certificate. */
    forceHttps: !/^(0|false|no)$/i.test(env('WEB_FORCE_HTTPS', 'true')),
    /** Behind Cloudflare / another proxy: trust X-Forwarded-For from this comma-separated list of IPs (empty = never). */
    trustProxy: env('WEB_TRUST_PROXY').split(',').map(s => s.trim()).filter(Boolean),
  },
  // VPS hosting (customer VPSes as Docker containers). Needs the `docker` CLI; see src/vps/index.ts.
  vps: {
    runtime: env('VPS_RUNTIME', 'auto').toLowerCase() as 'auto' | 'docker' | 'mock' | 'off',
    ociRuntime: env('VPS_OCI_RUNTIME'),
    privileged: /^(1|true|yes)$/i.test(env('VPS_PRIVILEGED')),
    prebuild: env('VPS_PREBUILD_OS').split(',').map(s => s.trim()).filter(Boolean),
    basePrefixes: env('VPS_ALLOWED_BASE_PREFIXES', 'ubuntu:,debian:').split(',').map(s => s.trim()).filter(Boolean),
  },
  version: '4.1.0',
};

const WEAK = new Set(['', 'key', 'changeme', 'change_me', '00000000000000000000000000000000', 'secret', 'password']);

/** Refuse to boot with a missing/weak secret (the old daemon defaulted to a zero key). */
export function assertConfig(): void {
  if (WEAK.has(config.secret.toLowerCase()) || config.secret.length < 32) {
    throw new Error('DAEMON_SECRET is missing or weak (need >= 32 chars). Run: npm run configure -- --panel <url> --key <secret from panel>');
  }
  if (config.portMin < 1024 || config.portMax > 65535 || config.portMin >= config.portMax) {
    throw new Error('PORT_MIN/PORT_MAX must satisfy 1024 <= min < max <= 65535');
  }
  if (!/^postgres(ql)?:\/\//i.test(config.database.url)) {
    throw new Error('DATABASE_URL is missing. The daemon stores its state in PostgreSQL, e.g. DATABASE_URL=postgres://daemon:change-me@127.0.0.1:5432/monopanel_daemon');
  }
  const badServices = config.servicesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).filter(k => !['bot', 'nodejs', 'website', 'lavalink', 'vps'].includes(k));
  if (badServices.length || !config.services.length) {
    throw new Error(`NODE_SERVICES must list one or more of: bot, nodejs, website, lavalink, vps${badServices.length ? ` (unknown: ${badServices.join(', ')})` : ''}`);
  }
  for (const [name, port] of [['WEB_HTTP_PORT', config.web.httpPort], ['WEB_HTTPS_PORT', config.web.httpsPort]] as const) {
    if (port && (port < 1 || port > 65535)) throw new Error(`${name} must be between 1 and 65535`);
    if (port && port === config.port) throw new Error(`${name} must differ from DAEMON_PORT`);
  }
  if (config.web.httpsPort && !config.web.certDir) throw new Error('WEB_HTTPS_PORT needs WEB_CERT_DIR (a folder with <domain>/fullchain.pem and <domain>/privkey.pem)');
  if (!['auto', 'docker', 'mock', 'off'].includes(config.vps.runtime)) {
    throw new Error('VPS_RUNTIME must be one of: auto, docker, mock, off');
  }
  for (const d of [config.dataDir, config.volumesDir, config.backupsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o750 });
}
