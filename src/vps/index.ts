import { config } from '../config';
import { log } from '../log';
import { kindEnabled } from '../kinds';
import { HttpError } from '../safe';
import { createDockerRuntime } from './docker';
import { createMockRuntime } from './mock';
import { VpsRuntime } from './types';

let runtime: VpsRuntime | null = null;
let probed = false;

/**
 * Decides once at boot whether this node can host VPSes.
 *   VPS_RUNTIME=auto   (default) enable when the `docker` CLI answers, otherwise leave VPS hosting off
 *   VPS_RUNTIME=docker enable, and fail to boot if Docker does not answer
 *   VPS_RUNTIME=mock   simulated VPSes in memory (development only)
 *   VPS_RUNTIME=off    never host VPSes on this node
 * A node without Docker still runs game/app servers (process runtime), it just answers 501 on /v1/vps.
 */
export async function initVps(): Promise<VpsRuntime | null> {
  if (probed) return runtime;
  probed = true;
  const want = config.vps.runtime;
  if (!kindEnabled('vps')) { log.info('VPS hosting is not part of this node\'s services (NODE_SERVICES), so it stays off'); return null; }
  if (want === 'off') { log.info('VPS hosting is disabled (VPS_RUNTIME=off)'); return null; }
  if (want === 'mock') {
    log.warn('VPS_RUNTIME=mock: simulated VPSes only. Not for production.');
    return (runtime = createMockRuntime());
  }
  const docker = createDockerRuntime();
  try {
    const info = await docker.info();
    log.info(`VPS hosting enabled (docker ${info.version})`);
    if (config.vps.privileged && !config.vps.ociRuntime) {
      log.warn('VPS_PRIVILEGED=true: every VPS runs privileged (Docker works inside, but a VPS root user can escape to this host). Prefer VPS_OCI_RUNTIME=sysbox-runc.');
    }
    return (runtime = docker);
  } catch (e: any) {
    if (want === 'docker') throw new Error(`VPS_RUNTIME=docker but Docker did not answer: ${e.message}`);
    log.info(`VPS hosting is off on this node (Docker CLI not available: ${e.message}). Set VPS_RUNTIME=docker once Docker is installed.`);
    return null;
  }
}

export const vpsRuntime = (): VpsRuntime | null => runtime;

export function needVps(): VpsRuntime {
  if (!runtime) throw new HttpError(501, 'VPS hosting is not enabled on this node. Install Docker and set VPS_RUNTIME=docker (or auto).');
  return runtime;
}

/** Fire-and-forget: build the ROM image for the configured OS ids so the first customer does not wait for it. */
export function prebuildVpsImages(): void {
  if (runtime?.prebuild && config.vps.prebuild.length) void runtime.prebuild(config.vps.prebuild);
}
