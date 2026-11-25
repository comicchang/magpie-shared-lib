// Generic, vendor-agnostic HTTP balance/usage prober with multi-key aggregation
// for third-party LLM relay stations.
//
// Invariant: 1 provider = 1 balance row, regardless of how many API keys belong to it.
//
// Multi-key aggregation modes (`entry.balanceMode` or `entry.station.balanceMode`):
//   - `"shared"` (default): 1 vendor account with N API keys (e.g. per-model/per-group keys).
//     Probes ONCE using `balanceToken` > `key` > `keyGroups[0].key` > `keys[0].key` and reports `keyCount`.
//   - `"sum"`: N independent prepaid accounts pooled under one provider.
//     Deduplicates keys across `key`, `keys[]`, and `keyGroups[]`, probes each unique key once,
//     and aggregates into ONE single station entry (`balance_usd = sum`, `today_usd = sum`, `accounts[]`).
//
// Safety guards:
//   - Zero secret leakage in responses/errors (`redactSecret`)
//   - Unlimited-quota negative-spend guard (e.g. New-API `/api/usage/token` with `unlimited_quota: true`
//     returning `0 - cumulative_spend` is classified as `unlimited_key`, never shown as a scary negative balance)
//   - Negative-zero clamping (`-0.004 < v < 0` -> `0`)

import { readSecretFromEnv } from "./runtime.mjs";

const ENV_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Resolve either a literal value or `${ENV_VAR}` placeholder without leaking secrets on failure. */
export function resolveConfigSecret(raw, { envFile, repoRoot, env = process.env } = {}) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const m = ENV_PLACEHOLDER_RE.exec(trimmed);
  if (!m) return trimmed;
  return readSecretFromEnv(m[1], { envFile, repoRoot, env });
}

/** Extract a nested numeric value from an object/array via dot path (e.g. `data.quota` or `balance_infos.0.total_balance`). */
export function getByDotPath(obj, dotPath) {
  if (!obj || typeof obj !== "object" || typeof dotPath !== "string" || !dotPath.trim()) {
    return null;
  }
  let cur = obj;
  for (const seg of dotPath.trim().split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  if (cur == null || typeof cur === "boolean" || cur === "") return null;
  const num = Number(cur);
  return Number.isFinite(num) ? num : null;
}

/**
 * Safely evaluate either a plain dot path (`data.quota`) or a Magpie native `$` balance
 * formula (`$remaining`, `$data.quota / 500000 * 0.1 / 7.2`, `($a + $b) / 100`).
 * Uses a strict recursive-descent parser (never `eval` or `Function`).
 *
 * Returns `{ value, rawField, isFormula }`, where `isFormula` is true whenever arithmetic
 * operators appear (signaling the caller that unit conversion is already baked into the formula).
 */
export function evalBalancePath(obj, expr) {
  if (!obj || typeof obj !== "object" || typeof expr !== "string" || !expr.trim()) {
    return { value: null, rawField: null, isFormula: false };
  }
  const trimmed = expr.trim();
  // Fast path: plain dot path without `$` or arithmetic operators
  if (!trimmed.includes("$") && !/[+\-*/()]/.test(trimmed)) {
    const val = getByDotPath(obj, trimmed);
    return { value: val, rawField: val, isFormula: false };
  }

  // Tokenize: $dot.path | number | + - * / ( )
  const tokens = [];
  let i = 0;
  let hasOp = false;
  let firstFieldVal = null;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < trimmed.length && /[A-Za-z0-9_.]/.test(trimmed[j])) j += 1;
      const path = trimmed.slice(i + 1, j);
      if (!path) return { value: null, rawField: null, isFormula: false };
      const val = getByDotPath(obj, path);
      if (val == null) return { value: null, rawField: null, isFormula: hasOp };
      if (firstFieldVal == null) firstFieldVal = val;
      tokens.push({ type: "num", value: val });
      i = j;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let j = i;
      while (j < trimmed.length && ((trimmed[j] >= "0" && trimmed[j] <= "9") || trimmed[j] === ".")) j += 1;
      const num = Number(trimmed.slice(i, j));
      if (!Number.isFinite(num)) return { value: null, rawField: null, isFormula: false };
      tokens.push({ type: "num", value: num });
      i = j;
      continue;
    }
    if ("+-*/()".includes(ch)) {
      if ("+-*/".includes(ch)) hasOp = true;
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    return { value: null, rawField: null, isFormula: false };
  }

  if (tokens.length === 0) return { value: null, rawField: null, isFormula: false };

  let pos = 0;
  const peek = () => tokens[pos];
  const parseExpr = () => {
    let left = parseTerm();
    if (left == null) return null;
    while (peek()?.type === "+" || peek()?.type === "-") {
      const op = tokens[pos++].type;
      const right = parseTerm();
      if (right == null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = () => {
    let left = parseFactor();
    if (left == null) return null;
    while (peek()?.type === "*" || peek()?.type === "/") {
      const op = tokens[pos++].type;
      const right = parseFactor();
      if (right == null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };
  const parseFactor = () => {
    const tok = peek();
    if (!tok) return null;
    if (tok.type === "+") {
      pos += 1;
      return parseFactor();
    }
    if (tok.type === "-") {
      pos += 1;
      const v = parseFactor();
      return v == null ? null : -v;
    }
    if (tok.type === "(") {
      pos += 1;
      const v = parseExpr();
      if (v == null || peek()?.type !== ")") return null;
      pos += 1;
      return v;
    }
    if (tok.type === "num") {
      pos += 1;
      return tok.value;
    }
    return null;
  };

  const result = parseExpr();
  if (pos !== tokens.length || result == null || !Number.isFinite(result)) {
    return { value: null, rawField: firstFieldVal, isFormula: hasOp };
  }
  return { value: result, rawField: firstFieldVal ?? result, isFormula: hasOp };
}

/** Redact any accidental secret token from error strings before exposing to UI/logs. */
export function redactSecret(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 6) {
      out = out.split(s).join("[REDACTED]");
    }
  }
  return out.slice(0, 300);
}

/** Clamp IEEE-754 negative zero and tiny sub-cent overdraft dust (`-0.005 < v < 0`) to `0`. */
export function clampNearZeroUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (Object.is(n, -0) || (n < 0 && n > -0.005)) return 0;
  return Number(n.toFixed(4));
}

/** Canonical station identifier for a provider entry. */
export function canonicalStationId(entry) {
  const stMeta = entry?.station && typeof entry.station === "object" ? entry.station : {};
  return String(stMeta.id || entry?.id || "").trim().toLowerCase();
}

/**
 * Collect and deduplicate all API keys declared on a provider entry
 * (`key`, `keys[]`, and `keyGroups[]`), preserving declaration order.
 */
export function collectStationKeys(entry, envOpts = {}) {
  const rawList = [];
  if (typeof entry?.key === "string" && entry.key.trim()) {
    rawList.push({ label: entry.name || entry.id || "primary", raw: entry.key });
  }
  if (Array.isArray(entry?.keys)) {
    for (let i = 0; i < entry.keys.length; i++) {
      const item = entry.keys[i];
      const raw = typeof item === "string" ? item : item?.key;
      if (typeof raw === "string" && raw.trim()) {
        rawList.push({ label: item?.name || item?.id || `key-${i + 1}`, raw });
      }
    }
  }
  if (Array.isArray(entry?.keyGroups)) {
    for (let i = 0; i < entry.keyGroups.length; i++) {
      const grp = entry.keyGroups[i];
      if (typeof grp?.key === "string" && grp.key.trim()) {
        rawList.push({ label: grp.id || grp.name || `group-${i + 1}`, raw: grp.key });
      }
    }
  }

  const seenResolved = new Set();
  const seenRaw = new Set();
  const resolvedKeys = [];
  let unresolvedCount = 0;

  for (const item of rawList) {
    const rawTrimmed = item.raw.trim();
    const resolved = resolveConfigSecret(rawTrimmed, envOpts);
    if (resolved) {
      if (seenResolved.has(resolved)) continue;
      seenResolved.add(resolved);
      resolvedKeys.push({ label: item.label, token: resolved, raw: rawTrimmed });
    } else if (!seenRaw.has(rawTrimmed)) {
      seenRaw.add(rawTrimmed);
      unresolvedCount += 1;
    }
  }

  return {
    keys: resolvedKeys,
    primaryKey: resolvedKeys[0]?.token || "",
    keyCount: resolvedKeys.length + unresolvedCount,
    hasConfiguredKey: rawList.length > 0,
  };
}

function isUnlimitedNegativeResponse(doc, rawBal) {
  if (rawBal == null || rawBal > 0) return false;
  const data = doc?.data && typeof doc.data === "object" ? doc.data : doc;
  const uq = data?.user_quota && typeof data.user_quota === "object" ? data.user_quota : null;
  if (data?.unlimited_quota === true || uq?.unlimited_quota === true) return true;
  if (data?.is_unlimited === true || uq?.is_unlimited === true) return true;
  return false;
}

async function probeSingleCredential(entry, token, rawTokenDeclared, opts) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 15_000, envFile, repoRoot, env = process.env } = opts;
  const stMeta = entry?.station && typeof entry.station === "object" ? entry.station : {};
  const secrets = token ? [token] : [];
  const url = String(entry?.balanceURL || "").trim();

  if (!url) {
    return { status: "no_endpoint", consoleStatus: "NO_BALANCE_URL", balanceUsd: null, usedUsd: null, error: null };
  }
  if (!token && rawTokenDeclared) {
    return { status: "no_key", consoleStatus: "NO_KEY", balanceUsd: null, usedUsd: null, error: null };
  }

  const method = String(entry?.balanceMethod || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  if (entry?.balanceHeaders && typeof entry.balanceHeaders === "object") {
    for (const [hk, hv] of Object.entries(entry.balanceHeaders)) {
      const resolved = resolveConfigSecret(String(hv ?? ""), { envFile, repoRoot, env });
      if (resolved) {
        headers[hk] = resolved;
        if (ENV_PLACEHOLDER_RE.test(String(hv ?? "").trim())) secrets.push(resolved);
      }
    }
  }
  if (stMeta.userId) {
    const uid = resolveConfigSecret(String(stMeta.userId), { envFile, repoRoot, env });
    if (uid) headers["New-Api-User"] = uid;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return {
        status: "error",
        consoleStatus: `HTTP_${res.status}`,
        balanceUsd: null,
        usedUsd: null,
        error: redactSecret(text, secrets),
      };
    }

    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return { status: "error", consoleStatus: "INVALID_JSON", balanceUsd: null, usedUsd: null, error: null };
    }

    const divisor = Number(entry?.balanceUnitDivisor ?? stMeta.quotaPerUsd ?? 1);
    const safeDivisor = Number.isFinite(divisor) && divisor > 0 ? divisor : 1;
    const usdPerUnit = Number(entry?.usdPerUnit ?? stMeta.usdPerUnit ?? 1);
    const safeMult = Number.isFinite(usdPerUnit) && usdPerUnit > 0 ? usdPerUnit : 1;

    const balEval = entry?.balancePath
      ? evalBalancePath(doc, entry.balancePath)
      : { value: null, rawField: null, isFormula: false };
    let rawBal = balEval.value;
    let balFromFormula = balEval.isFormula;
    let rawBalField = balEval.rawField;
    const usedEval = entry?.usedPath
      ? evalBalancePath(doc, entry.usedPath)
      : { value: null, rawField: null, isFormula: false };
    let rawUsed = usedEval.value;
    let usedFromFormula = usedEval.isFormula;

    if (rawBal == null && !entry?.balancePath && doc?.data && typeof doc.data === "object" && doc.data.quota != null) {
      rawBal = Number(doc.data.quota);
      rawBalField = rawBal;
      if (rawUsed == null && doc.data.used_quota != null) rawUsed = Number(doc.data.used_quota);
    }
    if (rawUsed == null && doc?.data && typeof doc.data === "object" && doc.data.total_used != null) {
      rawUsed = Number(doc.data.total_used);
    }

    const usedUsd =
      rawUsed != null && Number.isFinite(rawUsed)
        ? clampNearZeroUsd(usedFromFormula ? rawUsed : (rawUsed / safeDivisor) * safeMult)
        : null;

    // Unlimited API key returning negative `0 - cumulative_spend`: never surface as scary debt!
    if (isUnlimitedNegativeResponse(doc, rawBalField ?? rawBal)) {
      return {
        status: "unlimited_key",
        consoleStatus: "UNLIMITED_KEY",
        balanceUsd: null,
        usedUsd,
        error: null,
      };
    }

    const balanceUsd =
      rawBal != null && Number.isFinite(rawBal)
        ? clampNearZeroUsd(balFromFormula ? rawBal : (rawBal / safeDivisor) * safeMult)
        : null;

    return {
      status: balanceUsd != null ? "ok" : "parse_error",
      consoleStatus: balanceUsd != null ? "OK" : "MISSING_BALANCE",
      balanceUsd,
      usedUsd,
      error: null,
    };
  } catch (err) {
    return {
      status: "error",
      consoleStatus: "FETCH_ERROR",
      balanceUsd: null,
      usedUsd: null,
      error: redactSecret(err?.message || err, secrets),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a single third-party station entry over HTTP and normalize to Station Hub's snapshot shape.
 * Always emits strictly ONE station record even when multiple API keys (`keys[]` / `keyGroups[]`) exist.
 */
export async function probeStation(entry, opts = {}) {
  const { envFile, repoRoot, env = process.env } = opts;
  const stMeta = entry?.station && typeof entry.station === "object" ? entry.station : {};
  const stationId = String(stMeta.id || entry?.id || "").trim();
  const displayName = String(entry?.name || stationId || "unknown").trim();
  const rawMode = String(entry?.balanceMode ?? stMeta.balanceMode ?? "shared").trim().toLowerCase();
  const balanceMode = rawMode === "sum" ? "sum" : "shared";

  const keyInfo = collectStationKeys(entry, { envFile, repoRoot, env });

  if (stMeta.off === true || entry?.off === true) {
    return {
      station: stationId || displayName,
      name: displayName,
      status: "disabled",
      balanceMode,
      keyCount: keyInfo.keyCount,
      console: { status: "DISABLED" },
      eta: null,
    };
  }

  // Mode 1: Sum independent prepaid accounts under one provider -> still 1 aggregated balance card!
  if (balanceMode === "sum" && !entry?.balanceToken && keyInfo.keys.length > 1) {
    const results = await Promise.all(
      keyInfo.keys.map(async (k) => ({
        label: k.label,
        ...(await probeSingleCredential(entry, k.token, true, opts)),
      }))
    );
    const okBalances = results.filter((r) => r.balanceUsd != null).map((r) => r.balanceUsd);
    const okUsed = results.filter((r) => r.usedUsd != null).map((r) => r.usedUsd);
    const anyOk = okBalances.length > 0;
    const allOk = okBalances.length === results.length;
    const totalBal = anyOk ? clampNearZeroUsd(okBalances.reduce((a, b) => a + b, 0)) : null;
    const totalUsed = okUsed.length > 0 ? clampNearZeroUsd(okUsed.reduce((a, b) => a + b, 0)) : null;
    const firstErr = results.find((r) => r.error)?.error || null;

    return {
      station: stationId || displayName,
      name: displayName,
      status: allOk ? "ok" : anyOk ? "partial" : results[0]?.status || "error",
      balanceMode: "sum",
      keyCount: keyInfo.keyCount,
      console: {
        status: allOk ? "OK" : anyOk ? `PARTIAL_${okBalances.length}/${results.length}` : results[0]?.consoleStatus || "ERROR",
        ...(firstErr ? { error: firstErr } : {}),
      },
      accounts: results.map((r) => ({
        label: r.label,
        status: r.status,
        balance_usd: r.balanceUsd,
        today_usd: r.usedUsd,
      })),
      eta: anyOk
        ? {
            balance_usd: totalBal,
            today_usd: totalUsed,
            rate_usd_per_h: null,
            eta_hours: null,
          }
        : null,
    };
  }

  // Mode 2 (default): Shared account across N keys -> probe ONCE using balanceToken > primaryKey
  const rawBalanceToken = typeof entry?.balanceToken === "string" && entry.balanceToken.trim() ? entry.balanceToken.trim() : "";
  const token = rawBalanceToken
    ? resolveConfigSecret(rawBalanceToken, { envFile, repoRoot, env })
    : keyInfo.primaryKey;
  const rawTokenDeclared = Boolean(rawBalanceToken || keyInfo.hasConfiguredKey);

  const single = await probeSingleCredential(entry, token, rawTokenDeclared, opts);
  const hasEta = single.status === "ok" || single.status === "parse_error" || single.status === "unlimited_key";

  return {
    station: stationId || displayName,
    name: displayName,
    status: single.status,
    balanceMode,
    keyCount: keyInfo.keyCount,
    console: {
      status: single.consoleStatus,
      ...(single.error ? { error: single.error } : {}),
    },
    eta: hasEta
      ? {
          balance_usd: single.balanceUsd,
          today_usd: single.usedUsd,
          rate_usd_per_h: null,
          eta_hours: null,
        }
      : null,
  };
}

/**
 * Deduplicate raw station entries by canonical station ID, merging `keys[]` and `keyGroups[]`
 * so a provider split across multiple connection blocks NEVER produces duplicate balance cards.
 */
export function mergeStationEntriesById(entries) {
  const byId = new Map();
  const ordered = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const cid = canonicalStationId(entry);
    if (!cid) continue;
    const prev = byId.get(cid);
    if (!prev) {
      const clone = {
        ...entry,
        ...(Array.isArray(entry.keys) ? { keys: [...entry.keys] } : {}),
        ...(Array.isArray(entry.keyGroups) ? { keyGroups: [...entry.keyGroups] } : {}),
      };
      byId.set(cid, clone);
      ordered.push(clone);
      continue;
    }
    // Merge secondary entry's keys/keyGroups into the primary station entry; keep primary balanceURL/balanceToken.
    if (entry.key) {
      prev.keys = Array.isArray(prev.keys) ? prev.keys : [];
      prev.keys.push({ key: entry.key });
    }
    if (Array.isArray(entry.keys) && entry.keys.length) {
      prev.keys = [...(Array.isArray(prev.keys) ? prev.keys : []), ...entry.keys];
    }
    if (Array.isArray(entry.keyGroups) && entry.keyGroups.length) {
      prev.keyGroups = [...(Array.isArray(prev.keyGroups) ? prev.keyGroups : []), ...entry.keyGroups];
    }
    if (!prev.balanceURL && entry.balanceURL) prev.balanceURL = entry.balanceURL;
    if (!prev.balancePath && entry.balancePath) prev.balancePath = entry.balancePath;
    if (!prev.balanceToken && entry.balanceToken) prev.balanceToken = entry.balanceToken;
  }
  return ordered;
}

/** Probe configured stations concurrently (1 entry per unique station ID) and return Station Hub payload. */
export async function probeAllStations(entries, opts = {}) {
  const merged = mergeStationEntriesById(entries).filter((e) => e.balanceURL);
  const stations = await Promise.all(merged.map((entry) => probeStation(entry, opts)));
  const alerts = stations
    .filter((s) => s.status === "error" || s.status === "parse_error")
    .map((s) => ({ station: s.station, kind: "probe_error", status: s.console?.status || "ERROR" }));
  return { stations, alerts };
}
