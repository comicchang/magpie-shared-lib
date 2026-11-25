import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  defaultStateBaseDir,
  defaultCacheBaseDir,
  findWorkspaceRoot,
  resolveEnvFile,
  readSecretFromEnv,
  pyCmd,
} from "./runtime.mjs";
import { billingStateDir, billingProtectionSwitchPaths } from "./billing-protection.mjs";

describe("magpie-shared-lib/runtime — 通用运行时原语（零供应商/零仓库名硬编码）", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "magpie-shared-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaultStateBaseDir / defaultCacheBaseDir: MAGPIE_* 优先于 ~/.local/share/magpie & ~/.cache/magpie", () => {
    expect(defaultStateBaseDir({ MAGPIE_STATE_DIR: "/custom/state" })).toBe("/custom/state");
    expect(defaultCacheBaseDir({ MAGPIE_CACHE_DIR: "/custom/cache" })).toBe("/custom/cache");
    expect(defaultStateBaseDir({ MAGPIE_STATE_DIR: "   " })).toBe(join(homedir(), ".local", "share", "magpie"));
    expect(defaultCacheBaseDir({})).toBe(join(homedir(), ".cache", "magpie"));
  });

  it("findWorkspaceRoot: override > MAGPIE_WORKSPACE > custom envVars > 上溯目录", () => {
    const wsA = join(tmp, "ws-a");
    const wsB = join(tmp, "ws-b");
    const nested = join(wsB, "a", "b");
    mkdirSync(join(wsA, "scripts"), { recursive: true });
    mkdirSync(join(wsB, "scripts"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(wsA, "scripts", "marker.py"), "");
    writeFileSync(join(wsB, "scripts", "marker.py"), "");

    expect(findWorkspaceRoot("scripts/marker.py", { override: wsA, env: { MAGPIE_WORKSPACE: wsB } })).toBe(wsA);
    expect(findWorkspaceRoot("scripts/marker.py", { env: { MAGPIE_WORKSPACE: wsA, CUSTOM_WS: wsB }, envVars: ["MAGPIE_WORKSPACE", "CUSTOM_WS"] })).toBe(wsA);
    expect(findWorkspaceRoot("scripts/marker.py", { env: { CUSTOM_WS: wsB }, envVars: ["MAGPIE_WORKSPACE", "CUSTOM_WS"] })).toBe(wsB);
    expect(findWorkspaceRoot("scripts/marker.py", { env: {}, startDir: nested })).toBe(wsB);
    expect(findWorkspaceRoot("scripts/missing.py", { env: {}, startDir: tmp })).toBe("");
  });

  it("resolveEnvFile & readSecretFromEnv: process.env > MAGPIE_ENV_FILE / envFile > repo common.sh（自动剥外层引号、拦截哨兵）", () => {
    const envPath = join(tmp, "custom.env");
    writeFileSync(
      envPath,
      [
        'export CUSTOM_TOKEN="tok_quoted_123"',
        "SINGLE_TOKEN='tok_single_456'",
        'SENTINEL_TOKEN="FILL_ME_IN"',
      ].join("\n"),
    );

    expect(resolveEnvFile({ envFile: envPath, repoRoot: tmp, env: {} })).toBe(envPath);
    expect(resolveEnvFile({ repoRoot: tmp, env: { MAGPIE_ENV_FILE: envPath } })).toBe(envPath);
    expect(resolveEnvFile({ repoRoot: tmp, env: {} })).toBe(join(tmp, "profiles", "common", "common.sh"));

    expect(readSecretFromEnv("CUSTOM_TOKEN", { envFile: envPath, env: {} })).toBe("tok_quoted_123");
    expect(readSecretFromEnv("SINGLE_TOKEN", { envFile: envPath, env: {} })).toBe("tok_single_456");
    expect(readSecretFromEnv("CUSTOM_TOKEN", { envFile: envPath, env: { CUSTOM_TOKEN: "from_env" } })).toBe("from_env");
    expect(readSecretFromEnv("SENTINEL_TOKEN", { envFile: envPath, env: {}, sentinel: "FILL_ME_IN" })).toBe("");
    expect(readSecretFromEnv("MISSING_TOKEN", { envFile: envPath, env: {} })).toBe("");
  });

  it("pyCmd: MAGPIE_PYTHON > command -v python3，并支持自定义 envFile", () => {
    const envPath = join(tmp, "secrets.sh");
    writeFileSync(envPath, "export MY_FLAG=hello_from_custom_env\n");
    const fakePy = join(tmp, "fake-py");
    writeFileSync(fakePy, '#!/bin/sh\necho "FLAG=$MY_FLAG ARGS=$@"\n');
    chmodSync(fakePy, 0o755);

    const cmd = pyCmd(tmp, "job.py", ["--ok"], { envFile: envPath });
    expect(cmd).toContain("MAGPIE_PYTHON");
    expect(cmd).toContain(`"${envPath}"`);
    const r = spawnSync("bash", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, MAGPIE_PYTHON: fakePy },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`FLAG=hello_from_custom_env ARGS=${join(tmp, "scripts", "job.py")} --ok`);
  });

  it("billingStateDir & billingProtectionSwitchPaths 跟随 MAGPIE_STATE_DIR / MAGPIE_CACHE_DIR", () => {
    const prevState = process.env.MAGPIE_STATE_DIR;
    const prevCache = process.env.MAGPIE_CACHE_DIR;
    const prevBill = process.env.MAGPIE_BILLING_STATE_DIR;
    const prevOld = process.env.BILLING_GUARD_STATE_DIR;
    try {
      delete process.env.MAGPIE_BILLING_STATE_DIR;
      delete process.env.BILLING_GUARD_STATE_DIR;
      process.env.MAGPIE_STATE_DIR = join(tmp, "state");
      process.env.MAGPIE_CACHE_DIR = join(tmp, "cache");
      expect(billingStateDir()).toBe(join(tmp, "state", "billing-guard"));
      const sw = billingProtectionSwitchPaths();
      expect(sw.state_dir).toBe(join(tmp, "state", "billing-guard", "billing-protection.disabled"));
      expect(sw.cache_dir).toBe(join(tmp, "cache", "billing-protection.disabled"));
    } finally {
      if (prevState === undefined) delete process.env.MAGPIE_STATE_DIR;
      else process.env.MAGPIE_STATE_DIR = prevState;
      if (prevCache === undefined) delete process.env.MAGPIE_CACHE_DIR;
      else process.env.MAGPIE_CACHE_DIR = prevCache;
      if (prevBill === undefined) delete process.env.MAGPIE_BILLING_STATE_DIR;
      else process.env.MAGPIE_BILLING_STATE_DIR = prevBill;
      if (prevOld === undefined) delete process.env.BILLING_GUARD_STATE_DIR;
      else process.env.BILLING_GUARD_STATE_DIR = prevOld;
    }
  });
  it("pyCmd 转义参数中的 shell 元字符且 readSecretFromEnv 转义正则特殊字符", () => {
    const cmd = pyCmd("/tmp/repo", "run.py", ["$HOME", '`id`', 'a"b'], { envFile: null });
    expect(cmd).toContain('"\\$HOME"');
    expect(cmd).toContain('"\\`id\\`"');
    expect(cmd).toContain('"a\\"b"');

    const envFile = join(tmp, "regex.env");
    writeFileSync(envFile, "FOO_BAR=real\n");
    // Unescaped regex `.` would wrongly match FOO_BAR when looking up FOO.BAR
    expect(readSecretFromEnv("FOO.BAR", { envFile, env: {} })).toBe("");
    expect(readSecretFromEnv("FOO_BAR", { envFile, env: {} })).toBe("real");
  });
});
