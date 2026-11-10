/** What the panel asks the daemon to create for a customer VPS. */
export interface VpsSpec {
  id: string;
  /** OS image id from the panel, e.g. ubuntu-22.04 (see OS in runtime.ts). */
  image: string;
  /** Optional custom base image (must match VPS_ALLOWED_BASE_PREFIXES). */
  base: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  hostname: string;
  sshPort: number;
  rootPassword: string;
}

export interface VpsState {
  exists: boolean;
  status: 'running' | 'offline' | 'missing';
  startedAt?: string | null;
}

export interface VpsStats extends VpsState {
  cpuPct: number;
  ramUsedMb: number;
  diskUsedMb: number;
  netRxMb: number;
  netTxMb: number;
}

export interface VpsFileEntry {
  name: string;
  dir: boolean;
  link: boolean;
  size: number;
  modified: number;
}

export interface VpsExecResult {
  output: string;
  code: number;
  cwd: string;
}

export interface VpsSshx {
  running: boolean;
  url: string | null;
}

export interface VpsRuntime {
  kind: 'docker' | 'mock';
  info(): Promise<{ runtime: string; version: string }>;
  /** Build the ROM image for the given OS ids in the background so the first customer does not wait for it. */
  prebuild?(list: string[]): Promise<void>;
  create(v: VpsSpec): Promise<{ diskEnforced: boolean }>;
  reinstall(v: VpsSpec): Promise<{ diskEnforced: boolean }>;
  destroy(id: string): Promise<void>;
  power(id: string, action: string): Promise<void>;
  resize(id: string, limits: { cpu: number; ramMb: number }): Promise<void>;
  inspect(id: string): Promise<VpsState>;
  listAll(): Promise<{ id: string; status: 'running' | 'offline' }[]>;
  stats(id: string): Promise<VpsStats>;
  logs(id: string, tail?: number): Promise<string>;
  exec(id: string, cmd: string, cwd?: string): Promise<VpsExecResult>;
  list(id: string, path: string): Promise<VpsFileEntry[]>;
  read(id: string, path: string): Promise<string>;
  write(id: string, path: string, content: string): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
  remove(id: string, path: string): Promise<void>;
  rename(id: string, from: string, to: string): Promise<void>;
  setPassword(id: string, password: string): Promise<void>;
  sshx(id: string, action: 'start' | 'stop' | 'status'): Promise<VpsSshx>;
}
