import { route } from './http';
import { HttpError, assertId } from './safe';
import { ServerSpec } from './runtime/types';
import { kindEnabled, enabledKinds, isServerKind } from './kinds';
import * as store from './state';
import * as lavalink from './lavalink';
import * as nodejs from './nodejs';
import { webStatus, validDomain } from './web';

/**
 * Routes that belong to one hosting kind. They sit on the same port, secret and signing as every other daemon route,
 * so one daemon (one installer, one update) serves all of them.
 *
 *   /v1/servers/:id/lavalink/...   Lavalink servers
 *   /v1/servers/:id/nodejs/...     Node.js and website servers
 *   /v1/servers/:id/web            website servers
 *   /v1/services                   what this node can host
 */

function need(id: string, kinds: string[]): ServerSpec {
  const s = store.loadSpec(assertId(id));
  if (!s) throw new HttpError(404, 'Server is not registered on this node');
  const kind = s.kind || 'bot';
  if (!kinds.includes(kind)) throw new HttpError(409, `This is a ${kind} server; that action is only for ${kinds.join(' / ')} servers.`);
  return s;
}

export function registerServiceRoutes(): void {
  route('GET', '/v1/services', () => {
    const counts: Record<string, number> = {};
    for (const s of store.listSpecs()) { const k = s.kind || 'bot'; counts[k] = (counts[k] || 0) + 1; }
    return { services: enabledKinds(), servers: counts, web: webStatus() };
  });

  // ---- Lavalink ---------------------------------------------------------------------------------
  route('GET', '/v1/servers/:id/lavalink/config', ({ params }) => { need(params.id, ['lavalink']); return lavalink.readConfig(params.id); });
  route('PUT', '/v1/servers/:id/lavalink/config', ({ params, body }) => {
    const spec = need(params.id, ['lavalink']);
    return body?.raw !== undefined ? lavalink.writeRaw(spec, body.raw) : lavalink.writeSettings(spec, body?.settings);
  }, 256 * 1024);
  route('POST', '/v1/servers/:id/lavalink/reset', ({ params }) => lavalink.resetConfig(need(params.id, ['lavalink'])));
  route('GET', '/v1/servers/:id/lavalink/status', async ({ params }) => ({ ...(await lavalink.probe(need(params.id, ['lavalink']))), pluginJars: lavalink.listPluginJars(params.id) }));

  // ---- Node.js / website project tools ----------------------------------------------------------
  route('GET', '/v1/servers/:id/nodejs/project', ({ params }) => { need(params.id, ['nodejs', 'website', 'bot']); return nodejs.project(params.id); });
  route('GET', '/v1/servers/:id/nodejs/task', ({ params }) => { need(params.id, ['nodejs', 'website', 'bot']); return { run: nodejs.lastRun(params.id) }; });
  route('POST', '/v1/servers/:id/nodejs/task', async ({ params, body }) => {
    const spec = need(params.id, ['nodejs', 'website', 'bot']);
    return { ok: true, run: await nodejs.runTask(spec, body?.task) };
  });

  // ---- website ----------------------------------------------------------------------------------
  route('GET', '/v1/servers/:id/web', ({ params }) => {
    const spec = need(params.id, ['website']);
    return { domains: spec.domains || [], port: spec.ports[0]?.host || 0, proxy: webStatus(), enabled: kindEnabled('website') };
  });
}

export { isServerKind, validDomain };
