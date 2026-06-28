# pi-lsp

Vendored from `https://github.com/dreki-gg/pi-extensions/tree/524efa3c9a28291a578d820c460c6637b200fb02/packages/lsp` / `@dreki-gg/pi-lsp@0.4.1`.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `README.md` | Local concise README replaces upstream install/marketing content and records npm tarball integrity/provenance plus managed `~/.pi/agent/lsp.json` ownership. | Repo vendors extensions locally and forbids `pi install npm:...`; future syncs must preserve local Home Manager config ownership and `install.sh` extension loading. |
| `AGENTS.md` | Local-only sync manifest. | Protects intentional divergences during future upstream syncs. |
| `LICENSE` | Added root upstream MIT license from pinned commit; npm tarball metadata declares MIT but omits the license file. | Keeps license text with copied source. |
| `package.json` | Local package metadata points `pi.extensions` to `./index.ts`, keeps only runtime dependency `effect`, and records `piVendor` provenance. | Fits repo extension layout without adding root dependencies/scripts/tsconfig changes. |
| `config.ts` | Uses managed global config at `~/.pi/agent/lsp.json` and project overrides at `.pi/lsp.json`; scaffolds only to the managed path. | Matches Home Manager-owned LSP config and avoids stale upstream config shadowing it. |
| `tools/programs.ts` | Diagnostics now returns typed no-server/all-fail errors and avoids false clean output when some servers fail. | Prevents agents from trusting incomplete diagnostic checks. |
| `protocol.ts` | Clears current child/buffer and rejects pending requests on current process exit/error while ignoring stale child events. | Allows safe LSP respawn without stale processes clobbering new connections. |
| `client.ts` | Resets initialization, document, diagnostic, capability, and pending state when a server exits. | Restarted servers need fresh initialize and didOpen state. |
| `index.ts` | Status/help/scaffold text points to managed and project config paths. | UI must match local config search order. |
| `test/` | Local Vitest coverage for config precedence, diagnostics failure handling, and protocol respawn. | Guards local runtime divergences from upstream regressions. |

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/pi-lsp/`.
