export interface WorkspaceOptions {
  override?: string;
  env?: Record<string, string | undefined>;
  envVars?: string[];
  startDir?: string;
}

export interface EnvFileOptions {
  envFile?: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}

export interface SecretOptions extends EnvFileOptions {
  sentinel?: string;
}

export interface PyCmdOptions {
  envFile?: string;
  scriptsDir?: string;
}

export interface ListenRetryOptions {
  port: number;
  host?: string;
  retryMs?: number;
  windowMs?: number;
}

export declare const PYTHON_SHELL_PREFIX: string;
export declare const DEFAULT_LISTEN_RETRY_MS: number;
export declare const DEFAULT_LISTEN_RETRY_WINDOW_MS: number;

export declare function defaultStateBaseDir(env?: Record<string, string | undefined>): string;
export declare function defaultCacheBaseDir(env?: Record<string, string | undefined>): string;
export declare function findWorkspaceRoot(markerRel: string, opts?: WorkspaceOptions): string;
export declare function resolveEnvFile(opts?: EnvFileOptions): string;
export declare function readSecretFromEnv(name: string, opts?: SecretOptions): string;
export declare function pyCmd(repo: string, script: string, args?: string[], opts?: PyCmdOptions): string;
export declare function listenFailure(port: number, err: unknown): Error & { code: string; port: number; reason: string };
export declare function listenWithRetry(server: import("node:net").Server, opts: ListenRetryOptions): Promise<import("node:net").AddressInfo | string | null>;

export declare const STALE_MS: number;
export declare const BREAKER_SNAPSHOT_FRESH_MS: number;
export declare const CACHE_DEGRADATION_FIELDS: ReadonlyArray<readonly [string, string]>;

export declare function breakerDir(override?: string): string;
export declare function billingStateDir(override?: string): string;
export declare function billingProtectionSwitchPaths(
  stateDir?: string,
  cacheSwitchPath?: string | null,
): { state_dir: string; cache_dir: string | null };
export declare function readBillingProtectionSwitch(
  stateDir?: string,
  cacheSwitchPath?: string | null,
): { disabled: boolean; source: "state_dir" | "cache_dir" | "both" | null; paths: { state_dir: string; cache_dir: string | null } };
export declare function circuitReasonDomain(reason: string): "cache" | "price" | "funds" | "other";
export declare function readBreakerStatus(dir?: string, now?: number): Record<string, unknown>;
export declare function readSlowCircuits(stateDir?: string, now?: number): Record<string, unknown>;
export declare function readBillingProtection(opts?: {
  stateDir?: string;
  cacheSwitchPath?: string | null;
  breaker?: Record<string, unknown>;
  now?: number;
  stationFilter?: string | null;
}): Record<string, unknown>;
export declare function breakerView(brkDir?: string, bstDir?: string, now?: number): Record<string, unknown>;

export interface StationProbeEntry {
  id: string;
  name?: string;
  key?: string;
  keys?: Array<string | { key: string; id?: string; name?: string }>;
  keyGroups?: Array<{ id?: string; name?: string; key?: string }>;
  balanceURL?: string;
  balancePath?: string;
  usedPath?: string;
  balanceMethod?: "GET" | "POST";
  balanceToken?: string;
  balanceMode?: "shared" | "sum";
  balanceHeaders?: Record<string, string>;
  balanceUnitDivisor?: number;
  usdPerUnit?: number;
  off?: boolean;
  station?: {
    id?: string;
    usageCard?: boolean;
    off?: boolean;
    color?: string;
    balanceMode?: "shared" | "sum";
    userId?: string;
    quotaPerUsd?: number;
    usdPerUnit?: number;
  };
}

export interface StationProbeOptions extends EnvFileOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export declare function resolveConfigSecret(raw: string, opts?: EnvFileOptions): string;
export declare function getByDotPath(obj: unknown, dotPath: string): number | null;
export declare function evalBalancePath(
  obj: unknown,
  expr: string,
): { value: number | null; rawField: number | null; isFormula: boolean };
export declare function redactSecret(text: unknown, secrets?: string[]): string;
export declare function clampNearZeroUsd(value: unknown): number | null;
export declare function canonicalStationId(entry: StationProbeEntry): string;
export declare function collectStationKeys(
  entry: StationProbeEntry,
  envOpts?: EnvFileOptions,
): { keys: Array<{ label: string; token: string; raw: string }>; primaryKey: string; keyCount: number; hasConfiguredKey: boolean };
export declare function mergeStationEntriesById(entries: StationProbeEntry[]): StationProbeEntry[];
export declare function probeStation(entry: StationProbeEntry, opts?: StationProbeOptions): Promise<Record<string, unknown>>;
export declare function probeAllStations(
  entries: StationProbeEntry[],
  opts?: StationProbeOptions,
): Promise<{ stations: Record<string, unknown>[]; alerts: Record<string, unknown>[] }>;
