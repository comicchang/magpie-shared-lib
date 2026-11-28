/**
 * _shared/runtime.mjs — Magpie 插件通用运行时原语（零供应商耦合，可独立开源发布）。
 *
 * 统一封装跨插件共用的环境解析、Python CLI 桥接、凭据文件读取与端口重试监听，
 * 消除各插件之间的相对路径互引与对特定仓库目录结构的硬编码依赖。
 *
 * 环境变量优先级（通用名优先，兼容旧变量）：
 *   - 解释器：`MAGPIE_PYTHON` > `DOTAI_PYTHON` > `command -v python3`
 *   - 状态目录：`MAGPIE_STATE_DIR` > `~/.local/share/dotai`
 *   - 缓存目录：`MAGPIE_CACHE_DIR` > `~/.cache/dotai`
 *   - 凭据文件：`options.envFile` > `MAGPIE_ENV_FILE` > `<repoRoot>/profiles/common/common.sh`
 *   - 工作区根：`options.repoRoot` > `MAGPIE_WORKSPACE` > `DOTAI_REPO` > 向上探测 marker
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_FILL_SENTINEL = "__FILL_ME__";

/** 默认状态根目录：`MAGPIE_STATE_DIR` > `~/.local/share/dotai`。 */
export function defaultStateBaseDir(env = process.env) {
  const v = typeof env?.MAGPIE_STATE_DIR === "string" ? env.MAGPIE_STATE_DIR.trim() : "";
  return v || join(homedir(), ".local", "share", "dotai");
}

/** 默认缓存根目录：`MAGPIE_CACHE_DIR` > `~/.cache/dotai`。 */
export function defaultCacheBaseDir(env = process.env) {
  const v = typeof env?.MAGPIE_CACHE_DIR === "string" ? env.MAGPIE_CACHE_DIR.trim() : "";
  return v || join(homedir(), ".cache", "dotai");
}

/** 解析工作区根目录：显式 override > envVars > 从 startDir 向上探测 markerRel。 */
export function findWorkspaceRoot(
  markerRel,
  { override = "", envVars = ["MAGPIE_WORKSPACE", "DOTAI_REPO"], startDir = process.cwd(), maxDepth = 8, env = process.env } = {}
) {
  const check = (dir) => Boolean(dir && existsSync(join(dir, markerRel)));
  if (typeof override === "string" && override.trim() && check(override.trim())) return override.trim();
  for (const name of envVars) {
    const val = typeof env?.[name] === "string" ? env[name].trim() : "";
    if (val && check(val)) return val;
  }
  let cur = resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    if (check(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return "";
}

/** 解析可选凭据 env 文件路径（不强制要求文件存在）。 */
export function resolveEnvFile({ envFile = "", repoRoot = "", env = process.env } = {}) {
  if (typeof envFile === "string" && envFile.trim()) return envFile.trim();
  const fromEnv = typeof env?.MAGPIE_ENV_FILE === "string" ? env.MAGPIE_ENV_FILE.trim() : "";
  if (fromEnv) return fromEnv;
  if (typeof repoRoot === "string" && repoRoot.trim()) {
    return join(repoRoot.trim(), "profiles", "common", "common.sh");
  }
  return "";
}

/**
 * 读取敏感变量：优先进程环境变量，缺省回退可选 envFile（支持 `KEY=val` / `export KEY="val"`）。
 * 命中哨兵值（如 `__FILL_ME__`）视作未配置，返回空串。
 */
export function readSecretFromEnv(
  name,
  { envFile = "", repoRoot = "", sentinel = DEFAULT_FILL_SENTINEL, env = process.env } = {}
) {
  if (!name) return "";
  const fromEnv = env?.[name];
  if (typeof fromEnv === "string" && fromEnv && fromEnv !== sentinel) return fromEnv;
  const file = resolveEnvFile({ envFile, repoRoot, env });
  if (!file) return "";
  try {
    const text = readFileSync(file, "utf8");
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = text.match(new RegExp(`^(?:export\\s+)?${escaped}=(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, "m"));
    const val = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
    return val === sentinel ? "" : val;
  } catch {
    return "";
  }
}

function shDoubleQuote(s) {
  return `"${String(s).replace(/[\\"$`]/g, "\\$&")}"`;
}

/**
 * 通用 Python 解释器解析前缀（POSIX sh，绝不烘焙版本号或绝对路径）：
 *   `MAGPIE_PYTHON` > `DOTAI_PYTHON` > `command -v python3`；缺失显式 exit 127。
 */
export const PYTHON_SHELL_PREFIX = [
  '[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"',
  'py="${MAGPIE_PYTHON:-${DOTAI_PYTHON:-}}"; [ -n "$py" ] || py="$(command -v python3)"',
  'if [ -z "$py" ]; then echo "magpie-plugin: python3 不可用（请设 MAGPIE_PYTHON 或 DOTAI_PYTHON 或确保 PATH 有 python3）" >&2; exit 127; fi',
].join("; ");

/** 构造 Python CLI 执行命令：解析解释器 → 可选 source envFile → exec CLI。 */
export function pyCmd(repo, script, args = [], { envFile, scriptsDir } = {}) {
  const quoted = args.map((a) => shDoubleQuote(a)).join(" ");
  const cli = shDoubleQuote(scriptsDir ? join(scriptsDir, script) : join(repo, "scripts", script));
  const envPath = envFile === null ? "" : resolveEnvFile({ envFile, repoRoot: repo });
  const sourcePart = envPath ? `set -a; . ${shDoubleQuote(envPath)} 2>/dev/null; set +a; ` : "";
  return `${PYTHON_SHELL_PREFIX}; ${sourcePart}exec "$py" ${cli}${quoted ? ` ${quoted}` : ""}`;
}

// ---- 本地 HTTP 端口重试监听（宿主热重载防 EADDRINUSE 击穿进程） ----

export const DEFAULT_LISTEN_RETRY_MS = 250;
export const DEFAULT_LISTEN_RETRY_WINDOW_MS = 5000;

export function listenFailure(port, err) {
  const code = typeof err?.code === "string" && err.code !== "" ? err.code : "ELISTENFAILED";
  const reason = String(err?.message || err || "unknown");
  const failure = new Error(`监听 127.0.0.1:${port} 失败（${code}）：${reason}`);
  failure.name = "ListenError";
  failure.code = code;
  failure.port = port;
  failure.reason = reason;
  return failure;
}

export function listenWithRetry(server, { port, host = "127.0.0.1", retryMs, windowMs, signal } = {}) {
  const step = Number.isFinite(Number(retryMs)) && Number(retryMs) >= 0 ? Number(retryMs) : DEFAULT_LISTEN_RETRY_MS;
  const window =
    Number.isFinite(Number(windowMs)) && Number(windowMs) >= 0 ? Number(windowMs) : DEFAULT_LISTEN_RETRY_WINDOW_MS;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(listenFailure(port, new Error("aborted")));
      return;
    }
    const startedAt = Date.now();
    let timer = null;
    const onAbort = () => settle(reject, listenFailure(port, new Error("aborted")));
    const settle = (fn, arg) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", onAbort);
      server.off?.("error", onError);
      server.off?.("listening", onListening);
      fn(arg);
    };
    const onListening = () => settle(resolvePromise, server.address());
    const onError = (err) => {
      server.off?.("listening", onListening);
      if (err?.code === "EADDRINUSE" && Date.now() - startedAt + step <= window) {
        timer = setTimeout(attempt, step);
        timer.unref?.();
        return;
      }
      settle(reject, listenFailure(port, err));
    };
    const attempt = () => {
      timer = null;
      if (signal?.aborted) {
        settle(reject, listenFailure(port, new Error("aborted")));
        return;
      }
      server.listen(port, host, onListening);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    server.on("error", onError);
    attempt();
  });
}

// ---- 共享 Magpie 宿主生命周期与本地环回安全原语 ----

export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return false;
  const host = hostHeader.trim().toLowerCase();
  return /^127\.0\.0\.1(?::\d+)?$/.test(host) || /^localhost(?::\d+)?$/.test(host) || /^\[::1\](?::\d+)?$/.test(host);
}

export function isLoopbackOrigin(originHeader) {
  if (!originHeader) return true;
  if (String(originHeader).trim().toLowerCase() === "null") return true;
  try {
    const h = new URL(originHeader).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export function createCsrfToken(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

export function verifyCsrfToken(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function injectCsrfMeta(html, token, metaName = "magpie-csrf") {
  const safeToken = String(token || "").replace(/[^A-Za-z0-9._-]/g, "");
  const tag = `<meta name="${metaName}" content="${safeToken}">`;
  const source = String(html || "");
  if (source.includes("</head>")) {
    return source.replace("</head>", `  ${tag}\n</head>`);
  }
  return `${tag}\n${source}`;
}

/**
 * 绑定共享 Magpie 插件宿主（host.js）优雅停机钩子：
 *   - 监听 `process.stdin` 的 `end`/`close`（Magpie 调用 `h.in.Close()` 的第一信号，毫秒级释放端口/子进程）；
 *   - 监听 `beforeExit` / `exit` 兜底；
 *   - 绝不注册 `SIGTERM`/`SIGINT` 监听器，以免吞掉发给共享 `host.js` 的终止信号。
 */
export function bindHostShutdown(onStop, { watchHostStdin = true } = {}) {
  let called = false;
  const runOnce = () => {
    if (called) return;
    called = true;
    try {
      onStop();
    } catch {
      /* ignore shutdown errors */
    }
  };
  process.once("exit", runOnce);
  process.once("beforeExit", runOnce);
  const attachStdin =
    watchHostStdin &&
    process.stdin &&
    !process.stdin.isTTY &&
    !process.stdin.destroyed &&
    process.stdin.readable;
  if (attachStdin) {
    process.stdin.once("end", runOnce);
    process.stdin.once("close", runOnce);
  }
  return () => {
    process.removeListener("exit", runOnce);
    process.removeListener("beforeExit", runOnce);
    if (attachStdin) {
      process.stdin.removeListener("end", runOnce);
      process.stdin.removeListener("close", runOnce);
    }
  };
}
