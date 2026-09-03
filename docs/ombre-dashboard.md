# Ombre Brain Dashboard integration

## Architecture and production target

```text
Browser -> dwell Node backend -> Cloudflare Zero Trust -> OB Dashboard API
Claude Code -> Ombre Brain MCP (future; not implemented here)
```

The browser only calls `/api/ombre-dashboard/*`. It never receives the Dashboard password, session cookie, Cloudflare Access secret, upstream raw response, or `CLAUDE.md` content. Localhost is only the first real validation hop; the intended production upstream is the cloudflared/Zero Trust URL using the same code and different environment configuration.

## Environment

- `OMBRE_DASHBOARD_URL`: localhost for the first check, then the cloudflared HTTPS origin.
- `OMBRE_DASHBOARD_PASSWORD`: Dashboard login password, Node environment only.
- `OMBRE_DASHBOARD_TIMEOUT_MS`: upstream timeout, default 5000 ms.
- `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: optional pair; set only if the real policy accepts an Access service token.
- `QIUQIU_WORKSPACE`: future QIUQIU workspace, used only for readiness here.

Never put real values in `.env.example`, browser storage, frontend code, logs, or Git. Direct startup loads the gitignored project-root `.env.local`; an existing service environment value takes precedence.

## Implemented and mock-tested

- Login at `/auth/login`, cookie capture/cache, concurrent-login deduplication, and one re-login/retry after 401.
- Stable timeout, unavailable, authentication, and upstream error codes.
- Read-only backend routes for status, buckets, search, and detail.
- Version adapter producing stable bucket fields while discarding unknown raw fields.
- Optional server-only Cloudflare Access service-token headers.
- Native Memory page with filters, 300 ms search debounce, cards, and optimistic detail sheet.
- QIUQIU readiness; Claude Code always reports `offline` in this phase.

## Real validation completed on 2026-09-03

- Localhost `http://localhost:18001`: login, session cookie, status, buckets, search, and `/api/bucket/:id` detail passed.
- Cloudflared `https://www.reesia.xyz`: the same chain passed without code changes. The production `.env.local` URL now targets this origin.
- OB version: 2.11.0. Status uses `buckets.{dynamic,permanent,archive,total}`; list is a raw array; detail uses top-level content plus `metadata`.
- A deliberately invalid cookie produced 401; one automatic re-login and retry succeeded. Three concurrent login requests were deduplicated to one login.
- The public Cloudflare origin returned 200 without an Access redirect or challenge. No interactive login or service token is required by the current policy; Access variables remain unset.
- `/api/breath-debug` is supported and normalized into query, valence, arousal, threshold, counts, final score, pass state, and numeric score dimensions. Its UI is a collapsed advanced section inside Memory.

The upstream status total excludes archive while `/api/buckets` includes archived list entries; the Memory UI therefore shows the actual returned list length for its All count. Remaining real UI validation should be performed on the user's iPhone/browser because the available embedded preview did not execute any page JavaScript.

## Future Claude/MCP work (not active)

After Claude Code is available: confirm its version, start from `QIUQIU_WORKSPACE`, verify `CLAUDE.md` loading without exposing its content, configure OB MCP, validate `breath`, `hold`, `dream`, `grow`, and `trace`, then resume real tmux validation. Dashboard API access must not be routed through Claude and must not replace MCP.
