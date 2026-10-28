# Qiuqiu production source archive (2026-10-28)

This commit line preserves the deployed frontend source and the code actually run by the Claude bridge. The machine-specific data needed to operate a restored installation is deliberately outside Git.

## Source precedence and verification

- `public/`, `server.mjs`, `src/`, `package.json`, and `package-lock.json` were copied from the frontend deployment at `/opt/qiuqiu/chat-frontend`.
- `deploy/` uses the active bridge runtime at `/usr/local/lib/qiuqiu-claude-bridge` when that differs from the frontend deployment's older `deploy/` copy. The latter is still recorded in the hash manifest.
- `scripts/viewfinder-bridge.mjs` and `scripts/start-viewfinder-tunnel.ps1` came from the running Windows processes. The tunnel script's machine-specific SSH key path and target were replaced by `QIUQIU_SSH_KEY_PATH` and `QIUQIU_SSH_TARGET` in the archive. Set these in the user environment before installing its logon task.
- The completion reconciler's service and timer templates match the enabled systemd units byte for byte.
- [production-code-hashes-20261028.json](production-code-hashes-20261028.json) records production and archived SHA-256 values for each checked file. The frontend `deploy/` exceptions are the active bridge replacements; `package.json` and its lock file additionally include `playwright-core` as a test-only dependency.

Three local Shopping source files (`browser-policy.mjs`, `confirmation-extractor.mjs`, and `taobao-ssr.mjs`) complete imports in the deployed but currently dormant browser worker modules. They are included as source dependencies, not represented as running Windows services. The archive does not include local-only PWA pwa55 typing changes, FIFO/RSC experiments, staged ScreenPeek tool files, shopping worker experiments, temporary diagnostics, data stores, chat transcripts, credentials, or incident backups.

The deployed frontend uses Node 18. Its runtime dependencies remain unchanged. Browser tests use Playwright and a newer local Node; native database tests were checked with the production Node 18 version. The repository contains source and templates only: restore secrets, OAuth credentials, Claude sessions, MCP configuration, and chat history through their separate protected backups.
