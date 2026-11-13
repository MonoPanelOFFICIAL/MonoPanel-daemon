import { config } from './config';
import { HttpError } from './safe';

/**
 * Hosting kinds this ONE daemon can serve. The panel lets the owner choose which kinds they sell; a node can be limited
 * the same way with NODE_SERVICES (default: all of them), so a Lavalink-only node never accepts a website or a VPS.
 *
 *   bot       generic bot / app servers (Node.js, Python, anything the panel has an image for)
 *   nodejs    dedicated Node.js hosting (project info + npm tasks on top of the same server engine)
 *   website   full-stack website hosting (domains, built-in reverse proxy, optional HTTPS)
 *   lavalink  Lavalink audio node hosting (generated application.yml, plugins, live status)
 *   vps       customer VPSes (Docker), see ./vps
 */
export const KINDS = ['bot', 'nodejs', 'website', 'lavalink', 'vps'] as const;
export type Kind = typeof KINDS[number];
export const SERVER_KINDS = ['bot', 'nodejs', 'website', 'lavalink'] as const;
export type ServerKind = typeof SERVER_KINDS[number];

export const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
export const isServerKind = (v: unknown): v is ServerKind => typeof v === 'string' && (SERVER_KINDS as readonly string[]).includes(v);

export function kindEnabled(k: Kind): boolean { return config.services.includes(k); }
export const enabledKinds = (): Kind[] => KINDS.filter(kindEnabled);

/** Refuse work for a kind this node was not set up for. */
export function needKind(k: Kind): void {
  if (!kindEnabled(k)) throw new HttpError(403, `This node does not host ${k} services (NODE_SERVICES=${config.services.join(',')}).`);
}

/** Parses NODE_SERVICES / --services. Unknown names are rejected so a typo cannot silently disable a service. */
export function parseServices(raw: string): { ok: Kind[]; bad: string[] } {
  const parts = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bad = parts.filter(p => !isKind(p));
  const ok = KINDS.filter(k => parts.includes(k));
  return { ok, bad };
}
