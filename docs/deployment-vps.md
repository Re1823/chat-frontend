# QIUQIU VPS deployment

## Target architecture

```text
Phone -> https://qiuqiu.reesia.xyz -> Cloudflare Access/Tunnel -> nginx 127.0.0.1:8080 -> Node 127.0.0.1:4173
                                                                    -> model APIs
                                                                    -> OB cloudflared origin
```

Neither Node nor nginx exposes a new public port. The existing Xray service keeps public port 443; Cloudflare Tunnel reaches the loopback-only nginx listener through an outbound connection. The production recommendation keeps `CLAUDE_TMUX_ENABLED=false` until the real Claude Code/tmux environment has been verified.

## 1. Prepare the VPS

Install Node.js 20 or 22 LTS, nginx, cloudflared, and a firewall. Create a dedicated unprivileged account named `qiuqiu`, or replace `User` and `Group` in `deploy/chat-frontend.service` with another dedicated account. Put the application at `/opt/qiuqiu/chat-frontend` and make only that account the owner. The service needs write access only to its `data/` directory.

Do not copy a development `.env.local` into Git. Create `/etc/qiuqiu/chat-frontend.env`, owned by root and readable only by root and the service as appropriate:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
MODEL_UPSTREAM_ALLOWLIST=https://api.anthropic.com,https://api.openai.com,https://api.deepseek.com
OMBRE_DASHBOARD_URL=https://www.reesia.xyz
OMBRE_DASHBOARD_PASSWORD=replace-on-vps
OMBRE_DASHBOARD_TIMEOUT_MS=5000
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
CLAUDE_TMUX_ENABLED=false
QIUQIU_WORKSPACE=
```

Only add an exact model API origin after verifying it. Do not add localhost, private IPs, wildcards, URL credentials, paths, or a user-controlled domain. Every permitted hostname is resolved for each request and rejected if any result is private, loopback, link-local, or otherwise reserved. Redirects are disabled.

## 2. Install systemd

Copy `deploy/chat-frontend.service` to `/etc/systemd/system/chat-frontend.service`, confirm the service account and Node path, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chat-frontend
sudo systemctl status chat-frontend
sudo journalctl -u chat-frontend -f
```

Confirm that `curl http://127.0.0.1:4173/` succeeds on the VPS and that port 4173 is not reachable externally. `Restart=on-failure` handles process crashes; `WantedBy=multi-user.target` restores it after a VPS reboot.

## 3. nginx, Cloudflare Tunnel and HTTPS

Copy `deploy/nginx-qiuqiu.conf` into the nginx sites directory and enable it. It listens only on `127.0.0.1:8080`; do not add public 443 because the existing Xray service owns that port.

Create a named Cloudflare Tunnel and configure its public hostname `qiuqiu.reesia.xyz` with service `http://127.0.0.1:8080`. Install the tunnel as a systemd service using the token supplied by Cloudflare. Never place the token in Git, shell history, logs, or this document. Cloudflare supplies the public certificate, so this topology does not use certbot on the VPS.

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status cloudflared
```

The nginx configuration disables response and request buffering for NDJSON/SSE streaming and allows a five-minute upstream read. `/api/internal/` returns 403 in nginx and is never forwarded to Node. No additional inbound firewall port is required.

## 4. Access control and firewall

This is a personal application containing private memory data. Protect the entire hostname with Cloudflare Access before treating it as public. Recommended policy: allow only the owner's identity, use one-time PIN or the chosen identity provider, keep a bounded session duration, and do not create a bypass rule for `/api/*`. A future local Claude hook does not use the public hostname; it posts to `127.0.0.1` directly.

Keep the existing firewall rules for SSH and established services. Deny external 4173 and 8080; Cloudflare Tunnel is outbound-only. If IPv6 is used, apply the same restrictions to IPv6.

## 5. Deployment validation

- `systemctl is-enabled chat-frontend` and `systemctl is-active chat-frontend` both succeed.
- `ss -lntp` shows Node only on `127.0.0.1:4173`, nginx only on `127.0.0.1:8080`, and Xray still owns public 443.
- Cloudflare serves valid HTTPS for `qiuqiu.reesia.xyz` through the tunnel.
- An unauthenticated browser is stopped by Cloudflare Access.
- `/api/internal/anything` returns 403 at nginx.
- `/api/chat` streams NDJSON without buffering; stop/cancel and multi-turn chat still work.
- Allowed model providers work; an unlisted origin and private/metadata destination return a stable 400 error.
- OmbreBrain status, list, search, detail, and session re-login work through the Node backend.
- No password, API key, cookie, Access secret, `.env` file, or hook capture is served or logged.
- Reboot the VPS and confirm nginx and chat-frontend return automatically.
- Test `https://qiuqiu.reesia.xyz` from mobile data, not only local Wi-Fi.

## Updating

Back up the current release, deploy the reviewed source, run `npm test`, and restart only `chat-frontend`. Do not restart OmbreBrain or cloudflared as part of a frontend release. Check service logs and perform the validation list before removing the previous release.
