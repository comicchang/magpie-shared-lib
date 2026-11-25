# `magpie-shared-lib`

Zero-dependency shared ESM library for [Magpie](https://github.com/yetone/magpie) extensions and local companion services.

## Modules

- `runtime.mjs` — Portable path resolution (`MAGPIE_STATE_DIR`, `MAGPIE_CACHE_DIR`, `MAGPIE_WORKSPACE`, `MAGPIE_ENV_FILE`, `MAGPIE_PYTHON`), secret lookup with sentinel filtering, safe Python CLI command builder, and `EADDRINUSE` retry listener (`listenWithRetry`).
- `billing-protection.mjs` — Local-only read projection for slow-layer billing guard ledgers (`stations.json`, `circuits.json`) and fast-layer cache-breaker snapshots (zero network I/O, zero subprocess spawn).
- `station-probe.mjs` — Vendor-agnostic HTTP balance/usage prober supporting generic JSON dot-paths (`balancePath`) and standard New-API / One-API console responses, with automatic secret redaction.
- `usage-jsonl.mjs` — Fast backward-tail reader and domain aggregator for `~/.config/magpie/usage.jsonl` (`today` / `7d` / `30d`), with configurable `providers` / `excludedProviders` / `matcher` filters and atomic classic-JS sidecar writer.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MAGPIE_STATE_DIR` | `~/.local/share/magpie` | Base directory for persistent state ledgers |
| `MAGPIE_CACHE_DIR` | `~/.cache/magpie` | Base directory for local snapshots & kill switches |
| `MAGPIE_WORKSPACE` | *(auto-detect)* | Optional workspace root containing CLI adapters |
| `MAGPIE_ENV_FILE` | `<workspace>/profiles/common/common.sh` | Optional shell env file for `${ENV}` secret resolution |
| `MAGPIE_PYTHON` | `command -v python3` | Runtime Python 3 executable override |
| `MAGPIE_USAGE_SIDECAR` | `1` | Set to `0` to disable background usage sidecar polling |
| `MAGPIE_BILLING_STATE_DIR` | `<state>/billing-guard` | Billing protection state directory |

## Testing

```bash
bun test
```

## License

MIT
