/**
 * Fast, backward-tail reader and domain aggregator for Magpie's local `usage.jsonl`.
 *
 * Why this exists:
 * Magpie's built-in `magpie.read("usage:summary")` bridge endpoint intentionally
 * returns only the global Top-20 models and strips the `provider` prefix from
 * each model row (returning bare `model` + `input`/`output`/`calls`/`cost`).
 * Domain-scoped extensions therefore cannot filter
 * accurately or see models ranked below #20 via `usage:summary` alone.
 *
 * This module reads `~/.config/magpie/usage.jsonl` backwards from EOF in 512KB
 * chunks, stopping as soon as records fall past the 30-day window (<50ms on
 * 200MB+ logs), caches results by `(mtimeMs, size)`, prices tokens using
 * `~/.config/magpie/settings.json#modelPrices`, and atomically writes a
 * sandbox-friendly classic JS sidecar (`window.__MAGPIE_DOMAIN_USAGE__ = ...`).
 *
 * Zero external dependencies, zero network requests.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const EXCLUDED_RELAY_PROVIDERS = new Set([
  "codex",
  "openai-codex",
  "workbuddy",
  "workbuddy-ai",
  "trae-cn",
  "trae-global",
  "opencode-go",
  "opencode-zen-free",
  "agy-cli",
  "local session",
  "anthropic",
  "google",
  "openai",
]);

const DEFAULT_CHUNK_BYTES = 512 * 1024;
const STOP_AFTER_CONSECUTIVE_OLD = 64;

const priceCache = new Map();
const summaryCache = new Map();

export function defaultUsagePath(env = process.env) {
  const override = typeof env?.MAGPIE_USAGE_PATH === "string" ? env.MAGPIE_USAGE_PATH.trim() : "";
  if (override) return override;
  return join(homedir(), ".config", "magpie", "usage.jsonl");
}

export function defaultSettingsPath(env = process.env) {
  const override = typeof env?.MAGPIE_SETTINGS_PATH === "string" ? env.MAGPIE_SETTINGS_PATH.trim() : "";
  if (override) return override;
  return join(homedir(), ".config", "magpie", "settings.json");
}

export function classifyDomain(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (!p) return null;
  if (EXCLUDED_RELAY_PROVIDERS.has(p)) return null;
  return "relay";
}

export function matchesDomain(provider, domain) {
  const target = String(domain || "").trim().toLowerCase();
  if (!target || target === "all") return Boolean(String(provider || "").trim());
  return classifyDomain(provider) === target;
}

export function loadModelPrices(settingsPath = defaultSettingsPath()) {
  if (!settingsPath || !existsSync(settingsPath)) {
    return { exact: Object.create(null), lower: Object.create(null), stamp: "missing" };
  }
  let st;
  try {
    st = statSync(settingsPath);
  } catch {
    return { exact: Object.create(null), lower: Object.create(null), stamp: "unreadable" };
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = priceCache.get(settingsPath);
  if (cached && cached.stamp === stamp) {
    return cached;
  }
  const exact = Object.create(null);
  const lower = Object.create(null);
  try {
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    const mp = doc && typeof doc.modelPrices === "object" && doc.modelPrices ? doc.modelPrices : {};
    for (const [key, val] of Object.entries(mp)) {
      if (!val || typeof val !== "object") continue;
      const entry = {
        input: toNum(val.input),
        output: toNum(val.output),
        cache_read: toNum(val.cache_read ?? val.cacheRead),
        cache_write: toNum(val.cache_write ?? val.cacheWrite),
      };
      exact[key] = entry;
      lower[key.toLowerCase()] = entry;
    }
  } catch {
    // Non-fatal: missing/corrupt settings simply yields zero-priced fallback
  }
  const result = { exact, lower, stamp };
  priceCache.set(settingsPath, result);
  return result;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function computeRecordCost(record, priceTable) {
  if (!record || typeof record !== "object") return 0;
  if (typeof record.own_cost === "number" && Number.isFinite(record.own_cost) && record.own_cost >= 0) {
    return record.own_cost;
  }
  if (!priceTable) return 0;
  const prov = String(record.provider || "").trim();
  const model = String(record.model || "").trim();
  const served = String(record.served || "").trim();
  const candidates = [];
  if (prov && model) candidates.push(`${prov}/${model}`);
  if (prov && served && served !== model) candidates.push(`${prov}/${served}`);
  let price = null;
  for (const key of candidates) {
    price = priceTable.exact[key] || priceTable.lower[key.toLowerCase()];
    if (price) break;
  }
  if (!price) return 0;
  const inTok = toNum(record.in);
  const outTok = toNum(record.out);
  const cacheRead = toNum(record.cache_read);
  const cacheWrite = toNum(record.cache_write);
  return (
    (inTok * price.input +
      outTok * price.output +
      cacheRead * price.cache_read +
      cacheWrite * price.cache_write) /
    1e6
  );
}

function createPeriodBucket() {
  return {
    calls: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    cost: 0,
    modelsMap: new Map(),
    stationsMap: new Map(),
    accountsMap: new Map(),
  };
}

function addRecordToBucket(bucket, rec, cost) {
  const prov = String(rec.provider || "").trim();
  const bareModel = String(rec.model || "").trim() || "unknown";
  const fullModel = prov ? `${prov}/${bareModel}` : bareModel;
  const inTok = toNum(rec.in);
  const outTok = toNum(rec.out);
  const cacheRead = toNum(rec.cache_read);
  const cacheWrite = toNum(rec.cache_write);
  const tokens = inTok + outTok;
  const isError = Number(rec.status || 0) >= 400 ? 1 : 0;

  bucket.calls += 1;
  bucket.errors += isError;
  bucket.input += inTok;
  bucket.output += outTok;
  bucket.cacheRead += cacheRead;
  bucket.cacheWrite += cacheWrite;
  bucket.tokens += tokens;
  bucket.cost += cost;

  let m = bucket.modelsMap.get(fullModel);
  if (!m) {
    m = {
      provider: prov,
      model: fullModel,
      bareModel,
      calls: 0,
      errors: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
    };
    bucket.modelsMap.set(fullModel, m);
  }
  m.calls += 1;
  m.errors += isError;
  m.input += inTok;
  m.output += outTok;
  m.cacheRead += cacheRead;
  m.cacheWrite += cacheWrite;
  m.tokens += tokens;
  m.cost += cost;

  const provKey = prov.toLowerCase();
  let st = bucket.stationsMap.get(provKey);
  if (!st) {
    st = {
      provider: prov,
      modelsSet: new Set(),
      calls: 0,
      errors: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
    };
    bucket.stationsMap.set(provKey, st);
  }
  st.modelsSet.add(bareModel);
  st.calls += 1;
  st.errors += isError;
  st.input += inTok;
  st.output += outTok;
  st.cacheRead += cacheRead;
  st.cacheWrite += cacheWrite;
  st.tokens += tokens;
  st.cost += cost;

  const accountName = String(rec.providerAccount || rec.providerKeyName || "default").trim() || "default";
  const acctKey = `${provKey}\0${accountName}`;
  let ac = bucket.accountsMap.get(acctKey);
  if (!ac) {
    ac = {
      provider: prov,
      account: accountName,
      calls: 0,
      errors: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
    };
    bucket.accountsMap.set(acctKey, ac);
  }
  ac.calls += 1;
  ac.errors += isError;
  ac.input += inTok;
  ac.output += outTok;
  ac.cacheRead += cacheRead;
  ac.cacheWrite += cacheWrite;
  ac.tokens += tokens;
  ac.cost += cost;
}

function finalizeBucket(bucket) {
  const roundCost = (n) => Math.round(n * 1e6) / 1e6;
  const models = [...bucket.modelsMap.values()]
    .map((m) => ({ ...m, cost: roundCost(m.cost) }))
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost || b.calls - a.calls || a.model.localeCompare(b.model));

  const stations = [...bucket.stationsMap.values()]
    .map(({ modelsSet, ...rest }) => ({
      ...rest,
      modelCount: modelsSet.size,
      cost: roundCost(rest.cost),
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || b.calls - a.calls || a.provider.localeCompare(b.provider));

  const accounts = [...bucket.accountsMap.values()]
    .map((a) => ({ ...a, cost: roundCost(a.cost) }))
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost || b.calls - a.calls || a.account.localeCompare(b.account));

  return {
    calls: bucket.calls,
    errors: bucket.errors,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    tokens: bucket.tokens,
    cost: roundCost(bucket.cost),
    models,
    stations,
    accounts,
  };
}

function periodBounds(nowDate) {
  const d = nowDate instanceof Date ? nowDate : new Date(nowDate ?? Date.now());
  const midnightToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const since7d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6, 0, 0, 0, 0).getTime();
  const since30d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29, 0, 0, 0, 0).getTime();
  // Keep 1 extra day margin when scanning backwards to handle slightly out-of-order concurrent appends.
  const scanCutoff = since30d - 86_400_000;
  const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return { midnightToday, since7d, since30d, scanCutoff, dayKey, nowMs: d.getTime() };
}

function isRejectedRecord(rec) {
  if (!rec || typeof rec !== "object") return true;
  if (rec.rejected === true) return true;
  if (rec.source === "reported") return true;
  if (!rec.provider && Number(rec.status || 0) >= 400) return true;
  return false;
}

/**
 * Summarize a domain's usage (`today`, `7d`, `30d`) by scanning `usage.jsonl`
 * backwards from EOF until records fall past the 30-day window.
 */
export function summarizeUsageJsonl({
  domain,
  providers,
  matcher,
  excludedProviders,
  usagePath = defaultUsagePath(),
  settingsPath = defaultSettingsPath(),
  now = new Date(),
  chunkSize = DEFAULT_CHUNK_BYTES,
  useCache = true,
} = {}) {
  const targetDomain = String(domain || "all").trim().toLowerCase();
  const providerSet =
    providers != null
      ? new Set(Array.from(providers, (p) => String(p || "").trim().toLowerCase()).filter(Boolean))
      : null;
  const excludedSet =
    excludedProviders != null
      ? new Set(Array.from(excludedProviders, (p) => String(p || "").trim().toLowerCase()).filter(Boolean))
      : null;
  const matchFn =
    typeof matcher === "function"
      ? (p) => Boolean(matcher(p))
      : providerSet
        ? (p) => providerSet.has(String(p || "").trim().toLowerCase())
        : excludedSet
          ? (p) => {
              const key = String(p || "").trim().toLowerCase();
              return Boolean(key) && !excludedSet.has(key);
            }
          : (p) => matchesDomain(p, targetDomain);
  const customMatcher = typeof matcher === "function" || providerSet !== null || excludedSet !== null;
  const bounds = periodBounds(now);
  const priceTable = loadModelPrices(settingsPath);

  if (!usagePath || !existsSync(usagePath)) {
    return buildEmptyPayload(targetDomain, bounds.nowMs, "missing");
  }

  let st;
  try {
    st = statSync(usagePath);
  } catch {
    return buildEmptyPayload(targetDomain, bounds.nowMs, "unreadable");
  }

  const cacheKey = `${usagePath}\0${settingsPath}\0${targetDomain}\0${
    providerSet ? Array.from(providerSet).sort().join(",") : ""
  }\0${excludedSet ? Array.from(excludedSet).sort().join(",") : ""}`;
  const stamp = `${st.mtimeMs}:${st.size}:${priceTable.stamp}:${bounds.dayKey}`;
  if (useCache && typeof matcher !== "function") {
    const cached = summaryCache.get(cacheKey);
    if (cached && cached.stamp === stamp) {
      return cached.payload;
    }
  }

  const bToday = createPeriodBucket();
  const b7d = createPeriodBucket();
  const b30d = createPeriodBucket();

  const fd = openSync(usagePath, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.max(4096, Math.min(chunkSize, st.size || 4096)));
    let pos = st.size;
    let carry = "";
    let consecutiveOlder = 0;
    let stop = false;

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Fast-path timestamp extraction avoids JSON.parse on lines outside our window or domain.
      const tIdx = trimmed.indexOf('"t":"');
      if (tIdx >= 0) {
        const tStart = tIdx + 5;
        const tEnd = trimmed.indexOf('"', tStart);
        if (tEnd > tStart) {
          const fastTs = Date.parse(trimmed.slice(tStart, tEnd));
          if (Number.isFinite(fastTs)) {
            if (fastTs < bounds.scanCutoff) {
              consecutiveOlder += 1;
              if (consecutiveOlder >= STOP_AFTER_CONSECUTIVE_OLD) stop = true;
              return;
            }
            consecutiveOlder = 0;
            if (fastTs < bounds.since30d || fastTs > bounds.nowMs + 3_600_000) return;
          }
        }
      }
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (isRejectedRecord(rec)) return;
      const ts = Date.parse(rec.t);
      if (!Number.isFinite(ts)) return;
      if (ts < bounds.scanCutoff) {
        consecutiveOlder += 1;
        if (consecutiveOlder >= STOP_AFTER_CONSECUTIVE_OLD) {
          stop = true;
        }
        return;
      }
      consecutiveOlder = 0;
      if (ts < bounds.since30d || ts > bounds.nowMs + 3_600_000) return;
      if (!matchFn(rec.provider)) return;

      const cost = computeRecordCost(rec, priceTable);
      addRecordToBucket(b30d, rec, cost);
      if (ts >= bounds.since7d) addRecordToBucket(b7d, rec, cost);
      if (ts >= bounds.midnightToday) addRecordToBucket(bToday, rec, cost);
    };

    while (pos > 0 && !stop) {
      const toRead = Math.min(buf.length, pos);
      pos -= toRead;
      const bytesRead = readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      const chunkStr = buf.subarray(0, bytesRead).toString("utf8") + carry;
      const lines = chunkStr.split("\n");
      // First element may be a partial line whose head lies in an earlier chunk.
      carry = pos > 0 ? lines.shift() || "" : "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        processLine(lines[i]);
        if (stop) break;
      }
    }
    if (!stop && carry) {
      processLine(carry);
    }
  } finally {
    closeSync(fd);
  }

  const payload = {
    version: 1,
    domain: targetDomain,
    generatedAt: new Date(bounds.nowMs).toISOString(),
    source: "usage.jsonl",
    periods: {
      today: finalizeBucket(bToday),
      "7d": finalizeBucket(b7d),
      "30d": finalizeBucket(b30d),
    },
  };

  if (useCache && typeof matcher !== "function") {
    summaryCache.set(cacheKey, { stamp, payload });
  }
  return payload;
}

function buildEmptyPayload(domain, nowMs, source) {
  return {
    version: 1,
    domain,
    generatedAt: new Date(nowMs).toISOString(),
    source,
    periods: {
      today: finalizeBucket(createPeriodBucket()),
      "7d": finalizeBucket(createPeriodBucket()),
      "30d": finalizeBucket(createPeriodBucket()),
    },
  };
}

/**
 * Atomically write `window.__MAGPIE_DOMAIN_USAGE__ = ...;` for a Magpie plugin page.
 */
export function writeDomainUsageSidecar({
  domain,
  providers,
  matcher,
  excludedProviders,
  outPath,
  usagePath = defaultUsagePath(),
  settingsPath = defaultSettingsPath(),
  now = new Date(),
  useCache = true,
} = {}) {
  if (!outPath) throw new Error("writeDomainUsageSidecar requires outPath");
  const payload = summarizeUsageJsonl({
    domain,
    providers,
    matcher,
    excludedProviders,
    usagePath,
    settingsPath,
    now,
    useCache,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  const js =
    `// Generated locally from Magpie usage.jsonl (domain: ${payload.domain}). Zero remote requests.\n` +
    `window.__MAGPIE_DOMAIN_USAGE__ = ${JSON.stringify(payload)};\n`;
  const tmpPath = `${outPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, js, "utf8");
  renameSync(tmpPath, outPath);
  return payload;
}

/**
 * Start a non-blocking, unref()'d background poller that keeps `page/usage-data.js` fresh.
 */
export function startUsageSidecarPoller({
  domain,
  providers,
  matcher,
  excludedProviders,
  outPath,
  intervalMs = 60_000,
  usagePath,
  settingsPath,
  enabled = true,
  log = console,
} = {}) {
  if (
    !enabled ||
    !outPath ||
    process.env.MAGPIE_USAGE_SIDECAR === "0"
  ) {
    return {
      stop() {},
      trigger() {
        return null;
      },
    };
  }
  const trigger = () => {
    try {
      return writeDomainUsageSidecar({
        domain,
        providers,
        matcher,
        excludedProviders,
        outPath,
        usagePath,
        settingsPath,
      });
    } catch (err) {
      log?.warn?.(`[usage-sidecar:${domain}] refresh failed: ${err?.message || err}`);
      return null;
    }
  };
  trigger();
  const every = Math.max(5_000, Number(intervalMs) || 60_000);
  const timer = setInterval(trigger, every);
  if (typeof timer?.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
    trigger,
  };
}

export function clearUsageJsonlCaches() {
  priceCache.clear();
  summaryCache.clear();
}
