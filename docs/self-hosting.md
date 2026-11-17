# Self-hosting and operations

The English and Japanese quickstarts are in [README.md](../README.md) and [README.ja.md](../README.ja.md). The protocol contract is [docs/spec.md](spec.md).

## Production deployment

1. Configure DNS for a domain reachable from both receiver and sender. Open ports 80 and 443 for Caddy certificate issuance and HTTPS.
2. Copy `.env.example` to `.env`; replace `PUBLIC_ORIGIN` with an HTTPS origin, for example `https://qr.example.org`. Do not include a path, query, fragment, or trailing slash.
3. Run `docker compose config` to validate configuration, then `docker compose up -d --build`.
4. Check `https://<domain>/healthz` and `/readyz`, then open `/` and complete a test transfer from a real phone.

The default Compose subnet is `172.30.0.0/24`; change it and the trusted proxy CIDR together if that subnet conflicts with your host networking. The app has no persistent volume. Proxy volumes retain TLS certificates and Caddy configuration only. Keep one app process/replica: room state is not shared across processes.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | Required | Exact public HTTPS origin. Must also match the CLI `--server` origin |
| `HOST` | `0.0.0.0` | Internal app bind address |
| `PORT` | `8080` | Internal HTTP/WebSocket port |
| `NODE_ENV` | `production` | Only explicit `development`/`test` permits HTTP loopback origins |
| `MAX_ROOMS` | `1000` | Concurrent room limit |
| `MAX_SOCKETS` | `2200` | Total WebSocket limit |
| `MAX_UNAUTHENTICATED_SOCKETS` | `100` | Unauthenticated connection limit |
| `MAX_SOCKETS_PER_IP` | `60` | Per-IP connection limit |
| `TRUST_PROXY_CIDRS` | Empty outside Compose | Comma-separated directly connected proxy CIDRs; never trust arbitrary forwarded headers |
| `LOG_LEVEL` | `warn` | Operational policy; payload/access logging remains disabled |

The reference Compose configuration trusts only its proxy address. If you deploy behind another proxy, forward WebSocket upgrades and set the expected Origin unchanged. Keep connections alive for at least 90 seconds. Overwrite forwarded client headers at your edge and restrict direct access to the app.

`PUBLIC_ORIGIN` controls the Origin allowlist and CSP connection origin. The app does not derive security policy from an untrusted Host header. `/api/v1/rooms` and `/ws` require an exact matching Origin, including from non-browser clients. No broad CORS policy is exposed.

## Browser deployment under an Apache subpath

The browser app can be built for `https://myserver.example/qrtoss/` while other paths remain on the existing site. Apache removes the public prefix before forwarding to the app; the Node listener continues to serve its existing root routes.

Install Node.js 26 and npm, then build the checkout:

```sh
npm ci
QRTOSS_BASE_PATH=/qrtoss/ npm run build
```

`QRTOSS_BASE_PATH` is a **build-time** setting with a default of `/`. Supply an absolute path with leading and trailing slashes, such as `/qrtoss/`. Each segment may contain ASCII letters, digits, `.`, `_`, `~` and `-`; empty segments, `.` and `..` are rejected. URL origins, queries, fragments and percent-encoded paths are also invalid. Changing the deployment path requires rebuilding the web assets; setting the variable only when starting the server does not change an existing build. Export it in the shell or pass it as above: the setting is not read automatically from `.env` by this configuration.

Start one app process, normally through a service manager, with these runtime settings:

```sh
PUBLIC_ORIGIN=https://myserver.example \
  NODE_ENV=production HOST=127.0.0.1 PORT=8080 \
  TRUST_PROXY_CIDRS=127.0.0.1/32 npm start
```

`PUBLIC_ORIGIN` must remain `https://myserver.example`, without `/qrtoss` or a trailing slash. Browser `Origin` headers do not contain a path. The loopback bind prevents public connections directly to the app. Choose a different internal port if 8080 is already in use, and change the proxy targets to match.

For Apache 2.4.47 or later, enable `ssl`, `proxy`, `proxy_http` and `headers` (on Debian/Ubuntu, `sudo a2enmod ssl proxy proxy_http headers`). Add the following **inside the existing HTTPS VirtualHost** for `myserver.example`, before any broader `ProxyPass` rules. Keep its existing TLS certificate configuration.

```apache
RedirectMatch 301 "^/qrtoss$" "/qrtoss/"
ProxyRequests Off

<Location "/qrtoss/">
    RequestHeader unset X-Forwarded-For
    RequestHeader unset X-Forwarded-Host
    RequestHeader unset X-Forwarded-Server
    RequestHeader set X-Forwarded-Proto "https"
</Location>

# The WebSocket rule must precede the general HTTP rule.
ProxyPass        "/qrtoss/ws" "http://127.0.0.1:8080/ws" upgrade=websocket timeout=120
ProxyPassReverse "/qrtoss/ws" "http://127.0.0.1:8080/ws"
ProxyPass        "/qrtoss/" "http://127.0.0.1:8080/" timeout=120
ProxyPassReverse "/qrtoss/" "http://127.0.0.1:8080/"
```

Leave the incoming `Origin` header unchanged. Apache's [`mod_proxy_http` WebSocket upgrade support](https://httpd.apache.org/docs/2.4/mod/mod_proxy.html#websocket) requires 2.4.47 or later for this configuration. Check existing rewrite rules so they do not intercept these paths. Exclude qrtoss requests from every applicable access log; for example, define `SetEnvIf Request_URI "^/qrtoss(?:/|$)" qrtoss_request` with `mod_setenvif` and add `env=!qrtoss_request` to the site's existing `CustomLog` directives. If a log already uses a condition, combine the conditions rather than adding a second logging condition. Keep request-body and WebSocket payload capture disabled.

On Debian/Ubuntu, validate before reloading:

```sh
sudo apache2ctl configtest
# Run only after Syntax OK:
sudo systemctl reload apache2
curl --fail https://myserver.example/qrtoss/healthz
curl --fail https://myserver.example/qrtoss/readyz
```

Open `https://myserver.example/qrtoss/` and complete a transfer from a real phone. The pairing QR must point to `https://myserver.example/qrtoss/send#…`; `/send` has no trailing slash. The browser sends API requests to `/qrtoss/api/v1/rooms`, opens `/qrtoss/ws`, and loads bundled assets under `/qrtoss/assets/`.

This subpath mode is for browser receivers and senders. The CLI still accepts an origin only and builds root-level API, WebSocket and sender URLs; it cannot use a deployment exposed only under `/qrtoss/`. Use a separate root deployment if CLI support is needed. The supplied Docker Compose/Caddy configuration also remains a root deployment and does not pass this build setting into the image or remove a prefix. `npm run dev` serves the root deployment by default; testing a subpath build through that command also requires a prefix-stripping reverse proxy.

## Memory, logs and updates

Disable host swap and core dumps for a strict no-disk-residue deployment. On Linux, inspect swap configuration before running `sudo swapoff -a`, and disable configured swap persistently according to your distribution's administration guidance. Disable crash dump services, heap snapshots, packet/payload capture, request-body recording and external error collection. Encrypted swap has a different persistence guarantee and should be disclosed if used.

The reference application does not log access requests, messages, room identifiers, capabilities or content. Do not enable these in upstream proxies, tracing tools or hosting dashboards. OS network buffers and process memory necessarily contain transient data. Avoid production debugger ports.

Back up deployment configuration and TLS certificate volumes as needed; there is no transfer database to back up. A restart invalidates all rooms, keys and in-flight sessions. Build a new pinned image for upgrades and inform active users that they must pair again. Do not restore old room state.

## Troubleshooting

- **Phone camera unavailable:** use a trusted HTTPS URL in Safari/Chrome, allow camera access, and close other apps using the camera. LAN HTTP is not a production camera setup.
- **Origin denied:** use exactly the configured public origin, including the correct hostname and port. A `www` alias is a different origin.
- **Expired QR:** create a new QR; an old connection cannot be resumed. The five-minute pairing deadline does not cut off an already active session.
- **CLI QR distorted:** widen the terminal, adjust line spacing/theme, or use `--qr full`. With explicit `--pairing-url`, the CLI can fall back to displaying the secret URL.
- **Control characters rejected:** restart the CLI with `--jsonl` and pair again.
- **Delivery uncertain:** do not assume failure means no output. A slow stdout destination can complete after the sender's confirmation timeout. Rechecking a live transfer uses the same message ID and suppresses duplicate output.

## Local production-like tests

`npm run dev` permits only loopback HTTP. For phone tests use the same HTTPS reverse proxy setup as production, with certificates trusted by the phone. For automated CLI interoperability, tests use an isolated HTTPS CA/transport; the shipped CLI has no TLS-verification bypass.
