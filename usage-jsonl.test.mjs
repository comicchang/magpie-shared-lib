import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDomain,
  clearUsageJsonlCaches,
  matchesDomain,
  startUsageSidecarPoller,
  summarizeUsageJsonl,
  writeDomainUsageSidecar,
} from "./usage-jsonl.mjs";

function makeFixture(records, modelPrices = {}) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-usage-jsonl-"));
  const usagePath = join(dir, "usage.jsonl");
  const settingsPath = join(dir, "settings.json");
  const lines = records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
  writeFileSync(usagePath, lines, "utf8");
  writeFileSync(settingsPath, JSON.stringify({ modelPrices }), "utf8");
  return { dir, usagePath, settingsPath };
}

describe("usage-jsonl domain classifier", () => {
  test("classifies relay providers and excludes built-in subscriptions", () => {
    expect(classifyDomain("relay-alpha")).toBe("relay");
    expect(classifyDomain("relay-beta")).toBe("relay");
    expect(classifyDomain("codex")).toBeNull();
    expect(classifyDomain("opencode-go")).toBeNull();
    expect(matchesDomain("relay-alpha", "relay")).toBe(true);
    expect(matchesDomain("codex", "relay")).toBe(false);
    expect(matchesDomain("codex", "all")).toBe(true);
  });
});

describe("summarizeUsageJsonl", () => {
  test("aggregates today/7d/30d with custom providers filter and skips rejected/reported/corrupt records", () => {
    clearUsageJsonlCaches();
    const now = new Date(2026, 10, 25, 15, 0, 0);
    const oldDate = new Date(2026, 9, 10, 10, 0, 0).toISOString();
    const d20Ago = new Date(2026, 10, 5, 10, 0, 0).toISOString();
    const d3Ago = new Date(2026, 10, 22, 10, 0, 0).toISOString();
    const todayTs = new Date(2026, 10, 25, 11, 30, 0).toISOString();

    const oldNoise = Array.from({ length: 80 }, (_, idx) => ({
      t: oldDate,
      provider: "gateway-a",
      model: `old-model-${idx}`,
      in: 999999,
      out: 999999,
      status: 200,
    }));

    const records = [
      ...oldNoise,
      { t: d20Ago, provider: "gateway-a", model: "model-fast", in: 1_000_000, out: 0, cache_read: 0, status: 200 },
      { t: d3Ago, provider: "gateway-a", model: "model-fast", in: 500_000, out: 100_000, cache_read: 0, status: 200 },
      {
        t: todayTs,
        provider: "gateway-a",
        model: "model-fast",
        providerAccount: "key-1",
        in: 200_000,
        out: 50_000,
        cache_read: 1_000_000,
        cache_write: 0,
        status: 200,
      },
      { t: todayTs, provider: "gateway-a", model: "model-fast", in: 999, out: 999, rejected: true, status: 429 },
      { t: todayTs, provider: "gateway-a", model: "model-fast", in: 999, out: 999, source: "reported", status: 200 },
      "{not-json",
      {
        t: todayTs,
        provider: "router-b",
        model: "model-pro",
        providerAccount: "acct-alpha",
        in: 1_000_000,
        out: 500_000,
        cache_read: 0,
        status: 200,
      },
      {
        t: todayTs,
        provider: "router-b",
        model: "model-pro",
        providerAccount: "acct-beta",
        in: 2_000_000,
        out: 0,
        cache_read: 0,
        status: 200,
      },
      { t: todayTs, provider: "relay-one", model: "model-lite", in: 500_000, out: 100_000, status: 200 },
      { t: todayTs, provider: "relay-two", model: "model-mini", in: 100_000, out: 20_000, status: 200 },
      { t: todayTs, provider: "codex", model: "model-sub", in: 400_000, out: 50_000, status: 200 },
    ];

    const prices = {
      "gateway-a/model-fast": { input: 1.0, output: 2.0, cache_read: 0.1, cache_write: 0 },
      "router-b/model-pro": { input: 2.0, output: 10.0, cache_read: 0.2, cache_write: 0 },
      "relay-one/model-lite": { input: 0.5, output: 1.0, cache_read: 0, cache_write: 0 },
    };

    const { dir, usagePath, settingsPath } = makeFixture(records, prices);
    try {
      const gw = summarizeUsageJsonl({
        domain: "gateway-a",
        providers: ["gateway-a"],
        usagePath,
        settingsPath,
        now,
        chunkSize: 4096,
      });
      expect(gw.periods.today.calls).toBe(1);
      expect(gw.periods.today.tokens).toBe(250_000);
      expect(gw.periods.today.cost).toBeCloseTo(0.4, 5);
      expect(gw.periods["7d"].calls).toBe(2);
      expect(gw.periods["30d"].calls).toBe(3);

      const rb = summarizeUsageJsonl({
        domain: "router-b",
        providers: ["router-b"],
        usagePath,
        settingsPath,
        now,
        chunkSize: 4096,
      });
      expect(rb.periods.today.calls).toBe(2);
      expect(rb.periods.today.tokens).toBe(3_500_000);
      expect(rb.periods.today.accounts.length).toBe(2);
      expect(rb.periods.today.cost).toBeCloseTo(11.0, 5);

      const relay = summarizeUsageJsonl({
        domain: "relay",
        excludedProviders: ["gateway-a", "router-b", "codex"],
        usagePath,
        settingsPath,
        now,
        chunkSize: 4096,
      });
      expect(relay.periods.today.calls).toBe(2);
      expect(relay.periods.today.stations.map((s) => s.provider)).toEqual(["relay-one", "relay-two"]);
      expect(relay.periods.today.cost).toBeCloseTo(0.35, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes valid classic JS sidecar and respects poller disable flag", () => {
    clearUsageJsonlCaches();
    const now = new Date(2026, 10, 25, 15, 0, 0);
    const todayTs = new Date(2026, 10, 25, 12, 0, 0).toISOString();
    const { dir, usagePath, settingsPath } = makeFixture(
      [{ t: todayTs, provider: "gateway-a", model: "model-pro", in: 1000, out: 500, status: 200 }],
      { "gateway-a/model-pro": { input: 1, output: 2, cache_read: 0, cache_write: 0 } },
    );
    try {
      const outPath = join(dir, "page", "usage-data.js");
      writeDomainUsageSidecar({ domain: "gateway-a", providers: ["gateway-a"], outPath, usagePath, settingsPath, now });
      const text = readFileSync(outPath, "utf8");
      expect(text).toContain("window.__MAGPIE_DOMAIN_USAGE__ =");
      const sandbox = {};
      new Function("window", text)(sandbox);
      expect(sandbox.__MAGPIE_DOMAIN_USAGE__.domain).toBe("gateway-a");
      expect(sandbox.__MAGPIE_DOMAIN_USAGE__.periods.today.calls).toBe(1);

      const disabled = startUsageSidecarPoller({ domain: "gateway-a", outPath: join(dir, "noop.js"), enabled: false });
      expect(disabled.trigger()).toBeNull();
      disabled.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
