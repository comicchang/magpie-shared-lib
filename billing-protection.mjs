/**
 * _shared/billing-protection.mjs — 通用本地只读账单防护与缓存断路器读面（零供应商耦合）。
 *
 * 供 station-hub 与 router 看板共享同一套本地快照读取与状态语义：
 *   - 零 CLI spawn、零远端请求；
 *   - 只读 `<billingStateDir>/{stations.json,circuits.json}` 与 `<breakerDir>/cache-breaker-*.json`；
 *   - 路径优先显式参数 > `MAGPIE_BILLING_STATE_DIR` / `BILLING_GUARD_STATE_DIR` > `MAGPIE_STATE_DIR` / `MAGPIE_CACHE_DIR` > 默认值。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultCacheBaseDir, defaultStateBaseDir } from "./runtime.mjs";

/** 证据新鲜度阈值（2h）：余额/事件超 2h → stale，页面显 “—”。 */
export const STALE_MS = 2 * 60 * 60 * 1000;

/** 缓存断路器快照的可信窗口（1h）：超期即不覆盖 runner 读数。 */
export const BREAKER_SNAPSHOT_FRESH_MS = 60 * 60 * 1000;

/** 证据字段 → 归一类型（与 Python `CACHE_DEGRADATION_FIELDS` 逐字对齐）。 */
export const CACHE_DEGRADATION_FIELDS = [
  ["run", "count"],
  ["base", "count"],
  ["baseMissing", "flag"],
  ["depthMin", "count"],
  ["warmCounterparts", "count"],
  ["pairLow", "count"],
  ["pairWarm", "count"],
  ["pairLowShare", "ratio"],
  ["warmSuppressed", "flag"],
  ["pairSuppressed", "flag"],
  ["minuteBuckets", "count"],
  ["minuteGateOk", "flag"],
  ["eligibleLowBuckets", "count"],
  ["lowDurationMs", "ms"],
  ["missingBucket", "count"],
  ["lastClosedBucket", "count"],
  ["cohortMinuteBuckets", "count"],
  ["cohortLowDurationMs", "ms"],
  ["lowWin", "count"],
  ["chains", "count"],
  ["latestLowChains", "count"],
  ["warmChains", "count"],
  ["coldExcluded", "count"],
  ["ctxExcluded", "count"],
];

const PRICE_REASONS = new Set(["route_price_guard", "price", "price_mismatch"]);
const FUNDS_REASONS = new Set(["balance", "funds", "runway", "station_balance", "insufficient_balance"]);
const DEGRADATION_RANK = { unknown: 0, clean: 1, cold_no_baseline: 2, partial_miss: 3 };

const flagOrNull = (v) => (typeof v === "boolean" ? v : null);
const numOrNull = (v) =>
  v == null || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v);
const strOrNull = (v, max = 200) => (v == null ? null : String(v).slice(0, max));

export function breakerDir(override) {
  if (override) return override;
  const env = process.env.CACHE_HIT_RATE_STATE;
  return env ? dirname(env) : join(defaultCacheBaseDir(), "cache-hit-rate");
}

export function billingStateDir(override) {
  if (override) return override;
  for (const name of ["MAGPIE_BILLING_STATE_DIR", "BILLING_GUARD_STATE_DIR"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return join(defaultStateBaseDir(), "billing-guard");
}

export function billingProtectionSwitchPaths(stateDir, cacheSwitchPath) {
  return {
    state_dir: join(stateDir || billingStateDir(), "billing-protection.disabled"),
    cache_dir:
      cacheSwitchPath === undefined
        ? join(defaultCacheBaseDir(), "billing-protection.disabled")
        : cacheSwitchPath,
  };
}

export function readBillingProtectionSwitch(stateDir, cacheSwitchPath) {
  const paths = billingProtectionSwitchPaths(stateDir, cacheSwitchPath);
  const inState = existsSync(paths.state_dir);
  const inCache = paths.cache_dir === null ? false : existsSync(paths.cache_dir);
  const source = inState && inCache ? "both" : inState ? "state_dir" : inCache ? "cache_dir" : null;
  return { billing: source !== null, source, paths };
}

export function circuitReasonDomain(reason) {
  const r = String(reason ?? "").trim().toLowerCase();
  if (!r) return "other";
  if (r.startsWith("cache")) return "cache";
  if (PRICE_REASONS.has(r) || r.startsWith("price")) return "price";
  if (FUNDS_REASONS.has(r) || r.startsWith("balance") || r.startsWith("funds") || r.startsWith("runway")) return "funds";
  if (r.startsWith("identity")) return "identity";
  return "other";
}

function degradationValue(raw, kind) {
  if (kind === "flag") return flagOrNull(raw);
  const n = numOrNull(raw);
  if (n == null) return null;
  return kind === "count" ? Math.trunc(n) : n;
}

function degradationEvidence(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [name, kind] of CACHE_DEGRADATION_FIELDS) out[name] = degradationValue(raw[name], kind);
  return out;
}

export function cacheDegradationState(evidence) {
  if (!evidence) return "unknown";
  if (evidence.baseMissing === true) return "cold_no_baseline";
  if (evidence.lowWin == null && evidence.pairLowShare == null) return "unknown";
  const partial =
    (evidence.lowWin ?? 0) > 0 ||
    (evidence.pairLow ?? 0) > 0 ||
    evidence.warmSuppressed === true ||
    evidence.pairSuppressed === true;
  return partial ? "partial_miss" : "clean";
}

export function cacheDegradationFromPair({ provider, model, pair, snapshotAt = null, now = Date.now() } = {}) {
  const shadow = pair && typeof pair.shadow === "object" && pair.shadow ? pair.shadow : {};
  const lastEvidence = degradationEvidence(shadow.lastEvidence);
  const lastTrip = degradationEvidence(shadow.lastTripEvidence);
  const frame = lastEvidence ?? lastTrip;
  const writtenAt = numOrNull(snapshotAt);
  const ageMs = writtenAt == null ? null : Math.max(0, (Number(now) || Date.now()) - writtenAt);
  return {
    provider: provider == null ? null : String(provider).slice(0, 120),
    model: model == null ? null : String(model).slice(0, 200),
    source: frame ? "shadow" : null,
    state: cacheDegradationState(frame),
    penalized: false,
    affects: "none",
    observed_at: writtenAt == null ? null : new Date(writtenAt).toISOString(),
    age_ms: ageMs,
    stale: ageMs == null ? true : ageMs > BREAKER_SNAPSHOT_FRESH_MS,
    lowWin: frame?.lowWin ?? null,
    pairLowShare: frame?.pairLowShare ?? null,
    warmChains: frame?.warmChains ?? null,
    suppressed: {
      pair: frame?.pairSuppressed ?? null,
      warm_counterpart: frame?.warmSuppressed ?? null,
    },
    last_evidence: lastEvidence,
    last_trip: lastTrip,
  };
}

export function readBreakerStatus(dir, now = Date.now()) {
  const out = {
    dir,
    at: now,
    abnormal: false,
    cache_degradation: [],
    disabled: false,
    bypass: null,
    incidents: [],
    probations: [],
    snapshots: [],
  };
  try {
    out.disabled = existsSync(join(dir, "cache-breaker.disabled"));
  } catch {
    out.disabled = false;
  }
  try {
    const until = Number(JSON.parse(readFileSync(join(dir, "cache-breaker.bypass"), "utf-8"))?.until);
    if (Number.isFinite(until) && until > now) out.bypass = { until, remainingMs: until - now };
  } catch {
    out.bypass = null;
  }
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^cache-breaker-.+\.json$/.test(f));
  } catch {
    files = [];
  }
  let parsed = 0;
  let newest = 0;
  for (const f of files) {
    let body;
    try {
      body = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    parsed += 1;
    newest = Math.max(newest, Number(body?.writtenAt) || 0);
    const provider = f.slice("cache-breaker-".length, -".json".length);
    const writtenAt = Number(body?.writtenAt) || 0;
    out.snapshots.push({ provider, writtenAt, ageMs: writtenAt ? now - writtenAt : null, mode: body?.mode ?? null });
    for (const [model, st] of Object.entries(body?.pairs || {})) {
      if (!st) continue;
      out.cache_degradation.push(
        cacheDegradationFromPair({ provider, model, pair: st, snapshotAt: writtenAt || null, now })
      );
      if (st.incidentActive === true) {
        out.incidents.push({
          provider,
          model,
          trippedAt: st.trippedAt ?? null,
          rejected: st.rejected ?? 0,
          samples: st.samples ?? 0,
          probeUsed: st.probeUsed === true,
          probesUsed: Number(st.probesUsed) || 0,
          probeMax: Number(body?.config?.probeMax) || null,
          ttlRemainingMs: st.ttlRemainingMs ?? 0,
          recloseCount: st.recloseCount ?? 0,
        });
      } else if (Number(st.probationUntil) > now) {
        out.probations.push({
          provider,
          model,
          until: Number(st.probationUntil),
          remainingMs: Number(st.probationUntil) - now,
          consecutiveLow: st.consecutiveLow ?? 0,
          recloseCount: st.recloseCount ?? 0,
        });
      }
    }
  }
  out.abnormal = out.incidents.length > 0 || out.probations.length > 0 || out.disabled || out.bypass !== null;
  out.readable = parsed > 0;
  out.newestWrittenAt = newest || null;
  out.fresh = newest > 0 && now - newest <= BREAKER_SNAPSHOT_FRESH_MS;
  return out;
}

export function readSlowCircuits(dir, now = Date.now()) {
  const file = join(dir, "circuits.json");
  const out = {
    file,
    readable: false,
    valid: false,
    written_at: null,
    revision: null,
    error: null,
    entries: [],
    open: [],
    expired: 0,
    release_pending: [],
  };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
    out.readable = true;
  } catch (err) {
    out.error = existsSync(file) ? `circuits.json: ${String(err?.message || err).slice(0, 200)}` : null;
    return out;
  }
  out.written_at = strOrNull(doc?.written_at, 64);
  out.revision = numOrNull(doc?.revision);
  const shapeProblems = [];
  if (numOrNull(doc?.schema_version) !== 2) shapeProblems.push("schema_version!=2");
  if (out.revision == null) shapeProblems.push("revision 缺失");
  if (!Array.isArray(doc?.entries)) shapeProblems.push("entries 非数组");
  if (shapeProblems.length) {
    out.valid = false;
    out.error = `circuits.json: 结构非法（${shapeProblems.join("; ")}）`;
    return out;
  }
  out.valid = true;
  const nowMs = Number(now) || Date.now();
  for (const raw of doc.entries) {
    if (!raw || typeof raw !== "object") continue;
    const expiresMs = raw.expires_at ? Date.parse(raw.expires_at) : NaN;
    const expired = Number.isFinite(expiresMs) && expiresMs <= nowMs;
    const entry = {
      scope: strOrNull(raw.scope, 32),
      station_id: strOrNull(raw.station_id),
      provider_id: strOrNull(raw.provider_id),
      model: strOrNull(raw.model),
      state: raw.state === "released" ? "released" : "open",
      reason: strOrNull(raw.reason, 120),
      reason_domain: circuitReasonDomain(raw.reason),
      evidence_ref: typeof raw.evidence_ref === "string" ? raw.evidence_ref.slice(0, 300) : null,
      opened_at: strOrNull(raw.opened_at, 64),
      expires_at: strOrNull(raw.expires_at, 64),
      expired,
      retry_after_s: numOrNull(raw.retry_after_s),
    };
    out.entries.push(entry);
    if (entry.expired) {
      out.expired += 1;
      if (entry.state === "open" && entry.reason_domain !== "funds") out.release_pending.push(entry);
    } else if (entry.state === "open") out.open.push(entry);
  }
  return out;
}

function normalizeCoverage(cov) {
  if (!cov || typeof cov !== "object") return null;
  return {
    protected: numOrNull(cov.protected) ?? 0,
    total: numOrNull(cov.total) ?? 0,
    unguarded: Array.isArray(cov.unguarded) ? cov.unguarded.map((u) => String(u).slice(0, 120)) : [],
  };
}

function degradationWorse(a, b) {
  const ra = DEGRADATION_RANK[a?.state] ?? 0;
  const rb = DEGRADATION_RANK[b?.state] ?? 0;
  if (ra !== rb) return ra > rb;
  const la = a?.lowWin ?? -1;
  const lb = b?.lowWin ?? -1;
  if (la !== lb) return la > lb;
  return (a?.pairLowShare ?? 2) < (b?.pairLowShare ?? 2);
}

function worstDegradation(list) {
  let worst = null;
  for (const d of list) if (d && (worst === null || degradationWorse(d, worst))) worst = d;
  return worst;
}

export function stationCacheDegradation(entries, providers = []) {
  const ids = (Array.isArray(providers) ? providers : []).map((p) => String(p));
  const pairs = (Array.isArray(entries) ? entries : []).filter((d) => d && ids.includes(String(d.provider ?? "")));
  const worst = worstDegradation(pairs);
  return {
    source: worst?.source ?? null,
    state: worst?.state ?? "unknown",
    penalized: false,
    affects: "none",
    observed_at: worst?.observed_at ?? null,
    age_ms: worst?.age_ms ?? null,
    stale: worst ? worst.stale === true : null,
    lowWin: worst?.lowWin ?? null,
    pairLowShare: worst?.pairLowShare ?? null,
    warmChains: worst?.warmChains ?? null,
    suppressed: {
      pair: worst?.suppressed?.pair ?? null,
      warm_counterpart: worst?.suppressed?.warm_counterpart ?? null,
    },
    pairs,
  };
}

export function protectionStatus({ station, open = [], degradedAll = false, releasePending = [] }) {
  const s = station || {};
  if (s.refusing === true) return "refusing";
  if (open.length > 0) return "circuit_open";
  if (s.degraded === true || degradedAll) return "degraded";
  if (s.switching === true) return "switching";
  if (s.release_pending === true || releasePending.length > 0) return "unverified_release";
  if (s.observing === true) return "observing";
  const hasEvidence =
    s.last_event_at != null ||
    s.observed_requests != null ||
    s.settled_usd != null ||
    s.estimated_usd != null ||
    s.balance_usd != null;
  return hasEvidence ? "healthy" : "unknown";
}

function buildProtectionStation({
  s,
  open,
  releasePending = [],
  nowMs,
  generatedAt,
  degradedAll,
  incidents,
  breakerLive = false,
  cacheDegradation = [],
}) {
  const id = String(s.station_id ?? "").slice(0, 200);
  const mine = open.filter((e) => e.station_id === id);
  const released = releasePending.filter((e) => e.station_id === id);
  const lastMs = s.last_event_at ? Date.parse(s.last_event_at) : NaN;
  const lastAgeS = Number.isFinite(lastMs) ? Math.max(0, Math.round((nowMs - lastMs) / 1000)) : null;
  const balAt = s.balance_at ?? s.imported_at ?? generatedAt ?? null;
  const balMs = balAt ? Date.parse(balAt) : NaN;
  const balAgeS = Number.isFinite(balMs) ? Math.max(0, Math.round((nowMs - balMs) / 1000)) : null;
  const stale = lastAgeS != null ? lastAgeS * 1000 > STALE_MS : false;
  const balanceStale = s.balance_usd == null ? false : balAgeS == null || balAgeS * 1000 > STALE_MS;

  const cacheProviders =
    Array.isArray(s.provider_ids) && s.provider_ids.length ? s.provider_ids.map((x) => String(x)) : id ? [id] : [];
  const liveHit =
    breakerLive && incidents.length ? incidents.find((i) => cacheProviders.includes(String(i?.provider ?? ""))) : null;
  let cacheState = s.cache_state == null ? null : String(s.cache_state).slice(0, 40);
  let cacheStateSource = cacheState == null ? null : "runner";
  if (breakerLive) {
    cacheState = liveHit ? "incident" : "ok";
    cacheStateSource = "breaker";
  } else if (cacheState == null && incidents.length) {
    const hit = incidents.find((i) => cacheProviders.includes(String(i?.provider ?? "")));
    if (hit) {
      cacheState = "incident";
      cacheStateSource = "breaker-stale";
    }
  }

  const cacheIncident = cacheState === "incident";
  const cacheCircuit = cacheIncident
    ? {
        scope: "station",
        station_id: id,
        provider_id: null,
        model: null,
        state: "open",
        reason: "cache_collapse",
        reason_domain: "cache",
        evidence_ref: "cache-breaker:" + id,
        expired: false,
      }
    : null;
  const activeMine = cacheCircuit ? [...mine, cacheCircuit] : mine;
  let status = protectionStatus({ station: s, open: activeMine, degradedAll, releasePending: released });
  if (cacheIncident && status !== "refusing" && status !== "circuit_open") status = "refusing";
  const coverage = normalizeCoverage(s.guard_coverage);
  const reported = Array.isArray(s.active_circuits) ? s.active_circuits.length : numOrNull(s.active_circuits);

  return {
    station_id: id,
    name: strOrNull(s.name, 120),
    status,
    stale,
    last_event_at: strOrNull(s.last_event_at, 64),
    last_event_age_s: lastAgeS,
    observed_requests: numOrNull(s.observed_requests),
    settled_usd: numOrNull(s.settled_usd),
    estimated_usd: numOrNull(s.estimated_usd),
    balance_usd: numOrNull(s.balance_usd),
    balance_age_s: balAgeS,
    balance_stale: balanceStale,
    runway_h: numOrNull(s.runway_h),
    cache_state: cacheState,
    cache_state_source: cacheStateSource,
    cache_ratio: numOrNull(s.cache_ratio),
    cache_degradation: stationCacheDegradation(cacheDegradation, cacheProviders),
    active_circuits: activeMine,
    cache_circuits: activeMine.filter((e) => e.reason_domain === "cache"),
    money_circuits: activeMine.filter((e) => e.reason_domain !== "cache"),
    reported_active_circuits: reported,
    guard_coverage: coverage,
    armed: s.armed == null ? null : s.armed === true,
    degraded: s.degraded === true,
    evidence_ref: typeof s.evidence_ref === "string" ? s.evidence_ref.slice(0, 300) : null,
  };
}

export function readBillingProtection({
  stateDir,
  breaker = null,
  now = Date.now(),
  stationFilter = null,
  cacheSwitchPath,
} = {}) {
  const dir = stateDir || billingStateDir();
  const nowMs = Number(now) || Date.now();
  const circuits = readSlowCircuits(dir, nowMs);
  const sw = readBillingProtectionSwitch(dir, cacheSwitchPath);
  const out = {
    state_dir: dir,
    available: false,
    generated_at: null,
    now: nowMs,
    armed: false,
    degraded: false,
    disabled: { billing: sw.billing, source: sw.source, paths: sw.paths, cache: breaker?.disabled === true },
    bypass: null,
    guard_coverage: { protected: 0, total: 0, unguarded: [] },
    stale_after_s: Math.round(STALE_MS / 1000),
    stations: [],
    circuits: {
      revision: circuits.revision,
      written_at: circuits.written_at,
      open: circuits.open.length,
      expired: circuits.expired,
      released_pending_verification: circuits.release_pending.length,
      entries: circuits.entries,
      error: circuits.error,
    },
    global_circuits: circuits.open.filter((e) => e.scope === "global"),
    cache: null,
    cache_degradation: {
      source: "cache-breaker",
      available: false,
      state: "unknown",
      stale: null,
      penalized: false,
      affects: "none",
      note: "只读可见：不参与 status/degraded/cache_state/active_circuits 与任何拒绝判定",
      entries: [],
    },
    error: null,
    reads: { local: 2, remote_detection: 0, remote_control: 0 },
  };

  const stationsFile = join(dir, "stations.json");
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(stationsFile, "utf8"));
    out.available = true;
  } catch (err) {
    if (existsSync(stationsFile)) out.error = `stations.json: ${String(err?.message || err).slice(0, 200)}`;
  }

  if (doc && typeof doc === "object") {
    out.generated_at = strOrNull(doc.generated_at, 64);
    const cov = normalizeCoverage(doc.guard_coverage);
    if (cov) out.guard_coverage = cov;
  }
  out.armed = doc?.armed === true || out.available || circuits.readable || out.disabled.billing;
  out.degraded =
    doc?.degraded === true ||
    out.disabled.billing ||
    out.guard_coverage.unguarded.length > 0 ||
    out.error != null ||
    circuits.error != null;

  if (breaker && typeof breaker === "object") {
    out.cache = {
      disabled: breaker.disabled === true,
      bypass: breaker.bypass ?? null,
      incidents: Array.isArray(breaker.incidents) ? breaker.incidents : [],
      probations: Array.isArray(breaker.probations) ? breaker.probations : [],
    };
    if (breaker.bypass) {
      out.bypass = {
        until: numOrNull(breaker.bypass.until),
        remainingMs: numOrNull(breaker.bypass.remainingMs),
        scope: "cache",
        note: "仅缓存原因放行（5min/1h）；金额/价格/资金电路不受影响",
      };
    }
  }

  const rawStations = Array.isArray(doc?.stations) ? doc.stations : [];
  const incidents = out.cache?.incidents || [];
  const degradation = Array.isArray(breaker?.cache_degradation) ? breaker.cache_degradation : [];
  const worst = worstDegradation(degradation);
  out.cache_degradation = {
    ...out.cache_degradation,
    available: degradation.length > 0,
    state: worst?.state ?? "unknown",
    stale: worst ? worst.stale === true : null,
    entries: degradation,
  };
  out.stations = rawStations
    .filter((s) => s && typeof s === "object")
    .map((s) =>
      buildProtectionStation({
        s,
        open: circuits.open,
        releasePending: circuits.release_pending,
        nowMs,
        generatedAt: out.generated_at,
        degradedAll: doc?.degraded === true,
        incidents,
        breakerLive: breaker?.fresh === true,
        cacheDegradation: degradation,
      })
    )
    .filter((s) => !stationFilter || s.station_id === stationFilter);

  if (stationFilter) {
    out.circuits.entries = out.circuits.entries.filter((e) => e.station_id === stationFilter || e.scope === "global");
    out.global_circuits = out.global_circuits.filter((e) => !e.station_id || e.station_id === stationFilter);
  }
  return out;
}

export function breakerView(brkDir, stateDir, now = Date.now()) {
  const base = readBreakerStatus(brkDir, now);
  const circuits = readSlowCircuits(stateDir || billingStateDir(), now);
  return {
    ...base,
    bypass: base.bypass ? { ...base.bypass, scope: "cache" } : null,
    bypass_scope: "cache",
    bypass_note: "放行仅作用于缓存原因（5min/1h）；金额/价格/资金电路不受影响",
    slow_circuits: circuits.open.filter((e) => e.reason_domain !== "cache"),
    cache_circuits: circuits.open.filter((e) => e.reason_domain === "cache"),
    circuits_error: circuits.error,
  };
}
