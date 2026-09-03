# Claude Code tmux runtime

## Implementation status

### Implemented and tested with Windows mocks

- API providers remain on the existing API runtime and keep their legacy SSE compatibility.
- The browser can select `claude_tmux`, request runtime status, consume the existing NDJSON turn events, and request stop while busy.
- Prompt transport builds argv-only tmux calls and sends prompt text through `load-buffer` stdin, followed by `paste-buffer -p`, delay, Enter and cleanup.
- Registry persistence contains stable configuration only; restart reconciliation uses tmux session/pane metadata through an injected transport.
- Raw hook input is isolated in `claude-ingress`, which produces canonical internal frames before ordering or turn processing.
- Canonical frame ordering, deduplication, snapshot suffix handling, final handling, error handling, one-active-turn enforcement and late stop completion are covered by tests.
- The internal hook endpoint checks loopback origin and a backend-only secret.
- The hook sender reads full stdin JSON, uses a short timeout, writes nothing to stdout, and fails open.
- Raw capture is off by default, bounded, and writes only to the gitignored `data/` directory when explicitly enabled.

These tests use fake command runners and synthetic hook payloads. They prove the application-side contracts; they do not prove compatibility with an installed Claude Code or tmux version.

### Waiting for a real Claude Code environment

- Claude login and subscription access.
- The installed `claude --version`, `tmux -V`, and platform record.
- Whether this Claude version exposes a suitable reply-display hook at all.
- The exact inline `--settings` hook registration schema.
- The exact raw hook event names, payload fields, text semantics, ordering, final signal, and error signal.
- Escape behavior and which real hook/event confirms interruption.
- Real session creation, backend restart/reconnection, login/trust prompts, and end-to-end browser → tmux → Claude → hook → browser behavior.

Until this validation occurs, auto-create must remain disabled and candidate fields in `claude-ingress` must not be described as the actual Claude schema.

## Scope

This runtime connects the existing Web chat to one long-lived interactive Claude Code process inside one tmux session. It does not run `claude -p`, replay browser history, read assistant text from `capture-pane`, or manage multiple runtimes.

The browser's `chatSessionId`, the stable server `runtimeId`, each request's `turnId`, and Claude's possible message identifier are separate identities. The browser session id must never be used as a tmux session name.

## Platform boundary

Native Windows keeps all API providers and mock tests working, but the real tmux runtime remains disabled. Enable it only where Node, tmux, Claude Code, the hook script and the workspace share the same Linux/WSL/VPS environment.

Before enabling, record:

```sh
claude --version
tmux -V
uname -a
```

The current `claude-ingress` accepts several candidate raw fields only as an unverified adapter. Core ordering and turn modules consume canonical frames and do not know Claude hook field names.

## Lifecycle

Stable identity is stored in `data/claude-tmux-runtime.json`; busy state, subscribers, active turn and stop state remain in memory. On backend startup, the registry is loaded and reconciled with `tmux has-session` and `tmux list-panes` metadata. Stale persisted busy state is never trusted.

`CLAUDE_TMUX_AUTO_CREATE` defaults to false. With auto-create off, a missing session produces an explicit error and no process is started. With it on, launch arguments come only from server configuration. Keep it off until `CLAUDE_TMUX_LAUNCH_ARGS_JSON`, inline hook settings and the installed Claude version have been verified in the target environment.

The backend installs no exit handler that kills tmux. Browser refresh, browser close and Node restart therefore do not intentionally terminate the tmux session.

## Prompt and reply paths

Only the newest user prompt is injected into tmux. Browser `messages[]` is UI history and must never be replayed into the long-lived Claude context.

Prompt transport is:

```text
load-buffer from stdin
→ paste-buffer -p
→ configurable delay
→ send-keys Enter
→ delete-buffer
```

Prompt text is never placed in shell arguments. In the implemented application pipeline, reply text is expected to come from the protected hook endpoint, then be adapted into canonical frames, reordered, deduplicated, and mapped to the existing NDJSON turn events. This pipeline is mock-tested; the real Claude hook source remains unverified. `capture-pane` is not part of the reply path.

Stop transitions are `running → stop_requested → Escape → confirmed stopped`. A two-second timeout returns `stop_unconfirmed`; it does not emit a false `turn_stopped` or `turn_done`. A later valid Stop hook may still finish the turn.

## Hook security and sampling

`/api/internal/claude-code/events` accepts loopback requests with `X-Dwell-Hook-Secret`. The secret stays in the backend/hook environment and is never returned by the status API or saved in localStorage.

An enabled runtime requires an explicitly configured, stable `DWELL_CLAUDE_HOOK_SECRET`. It must remain the same across backend restarts so hooks from the already-running Claude process can reconnect.

`hooks/claude/post-event.mjs` reads complete stdin JSON, posts with a short timeout, produces no stdout, and fails open when the backend is unavailable or rejects the event.

Raw capture is disabled by default. For a short schema sampling session only, enable `DWELL_CLAUDE_HOOK_CAPTURE=true`. Output is written below the gitignored `data/` directory and stops growing at the configured safety limit. Disable and remove the capture after comparing real MessageDisplay/final/Stop payloads. Capture failures never affect the hook transport.

## Deferred validation — no schema assumptions

The PDF's names such as `MessageDisplay`, `message_id`, `index`, `delta`, `final`, `session_id`, `Stop`, and `StopFailure` are candidate inputs in the version adapter, not confirmed facts about the future installed version. The same applies to delta versus snapshot behavior, final/stop ordering, Escape outcome hooks, pane command metadata, login/trust prompts and transcript behavior. Real capture should change only the adapter and launch configuration, not canonical frames, frame ordering, turn storage, or browser events.
