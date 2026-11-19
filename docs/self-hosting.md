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
| `MAX_SOCKETS_PER_IP` | `60` | Connection limit per IPv4 address or aggregated IPv6 prefix |
| `IPV6_PREFIX_LENGTH` | `64` | IPv6 aggregation prefix length (1–128), shared by room creation, authentication failures and connection limits; use `56` to group a /56 |
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

## Cloudflare Workers and Durable Objects

The Cloudflare relay uses the same browser and CLI protocol as the Node relay. A Worker accepts HTTP and WebSocket requests, each room has one RoomDO, and a single CapacityDO manages admission. Both relays use `packages/relay-core/src/` for pairing, commit, expiry, heartbeat, message limits and ciphertext forwarding. Cloudflare deployments use the origin root; subpath builds are rejected by the Cloudflare commands.

Use Node.js 26, `npm ci` and a Cloudflare account with Durable Objects available. Choose a `workers.dev` URL or a custom domain managed by Cloudflare. Wrangler is pinned in `devDependencies`; a global installation is unnecessary. Check the current [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before choosing a plan. Standard WebSockets keep rooms in memory and incur duration charges while connected; this implementation deliberately avoids hibernation.

For local development:

```sh
npm ci
npm run dev:cloudflare
```

Open `https://127.0.0.1:8787`. Wrangler uses a local development certificate, which the browser may require you to trust. This loopback origin is for desktop development; real-phone tests require a reachable HTTPS deployment with a certificate trusted by the phone. The command builds the Web assets, then starts local workerd through Wrangler. Web asset changes require rebuilding and restarting. It overrides `PUBLIC_ORIGIN` only for this local command and disables Wrangler's route-based origin inference so the Worker sees the actual loopback HTTPS origin.

You can deploy without editing `wrangler.jsonc` by setting the shell environment variable `PUBLIC_ORIGIN`:

```sh
PUBLIC_ORIGIN=https://qrtoss.my-account.workers.dev npm run deploy:cloudflare
# Validate and package without uploading or deploying:
PUBLIC_ORIGIN=https://qrtoss.my-account.workers.dev npm run deploy:cloudflare -- --dry-run
# A custom domain is inferred from a non-workers.dev origin:
PUBLIC_ORIGIN=https://qr.example.com npm run deploy:cloudflare
```

The script generates a temporary configuration, sets `workers_dev`, `routes` and `vars.PUBLIC_ORIGIN` together, validates it, and removes it after Wrangler exits. The repository configuration is unchanged. For workers.dev, the Worker name in the URL must match `name` in `wrangler.jsonc`. `PUBLIC_ORIGIN` is read from the shell for deployment; it is not automatically loaded from a `.env` file. When omitted, deployment uses `wrangler.jsonc` as before.

Deployment (including `--dry-run`) also requires Go 1.24 or newer on PATH, or a Go executable selected with `GO`. After building the Web assets, it builds the four macOS/Linux arm64/amd64 CLI binaries using the version in `package.json`, embeds the deployment's public origin as the default server, and generates a launcher with SHA-256 verification. The release files are included in the same static assets at `/cli/<version>/`, with a copy of the launcher at `/run.sh`. No separate CLI deployment or `QRTOSS_*` environment variables are needed.

For example, after deploying to `https://qrtoss.kodogu.workers.dev`:

```sh
curl -fsSL https://qrtoss.kodogu.workers.dev/run.sh | sh
# Pass CLI options:
curl -fsSL https://qrtoss.kodogu.workers.dev/run.sh | sh -s -- --timeout 120
```

The launcher downloads, verifies and caches the binary, then receives one item and exits. It does not install a command on PATH. Each deployment includes the current CLI version only; retain older release assets separately if old versioned launcher URLs must remain available.

Alternatively, edit `wrangler.jsonc` and choose one hosting mode:

| Setting | Custom domain (repository default) | `workers.dev` |
| --- | --- | --- |
| `workers_dev` | `false` | `true` |
| `routes` | `[{"pattern":"qrtoss.example","custom_domain":true}]` with your hostname | `[]`, or omit the field |
| `vars.PUBLIC_ORIGIN` | `https://qrtoss.example` with your hostname | `https://qrtoss.<account-subdomain>.workers.dev` |

For `workers.dev`, use the account subdomain shown in Workers & Pages; it can be configured there if needed. The first hostname label must match `name` in `wrangler.jsonc` (default `qrtoss`, lowercased in the URL). This Worker name must be a DNS label of at most 63 letters, digits or hyphens, without a leading or trailing hyphen. See [Cloudflare's workers.dev routing guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

For example, update these fields in the existing file, retaining its other bindings, migration, asset settings and variables:

```json
{
  "name": "qrtoss",
  "workers_dev": true,
  "preview_urls": false,
  "routes": [],
  "vars": {
    "PUBLIC_ORIGIN": "https://qrtoss.my-account.workers.dev"
  }
}
```

Replace `my-account` with your account subdomain. Both modes require one exact HTTPS `PUBLIC_ORIGIN` without a port, path or trailing slash. Custom-domain routes and `workers.dev` hosting cannot be enabled together. Keep `preview_urls: false` to disable [version and alias URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/), `observability.enabled: false`, and `compatibility_flags: ["no_web_socket_compression"]`. Review the numeric limits below. `check:cloudflare` rejects inconsistent hosting settings before deployment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_ROOMS` | `1000` | Live room leases |
| `MAX_SOCKETS` | `2200` | All WebSocket leases |
| `MAX_UNAUTHENTICATED_SOCKETS` | `100` | WebSockets awaiting authentication |
| `MAX_SOCKETS_PER_IP` | `60` | Concurrent WebSockets per normalized IP key |
| `IPV6_PREFIX_LENGTH` | `64` | IPv6 rate/count aggregation prefix, 1–128 |
| `LOG_LEVEL` | `warn` | Reserved for fixed, non-sensitive events; the implementation emits no application logs |

The Cloudflare relay uses `CF-Connecting-IP`; `TRUST_PROXY_CIDRS` and `X-Forwarded-For` are Node settings and have no effect here. IPv4-mapped IPv6 addresses share their IPv4 key. Creation and authentication failure buckets use the same key as socket counts, with at most 4,096 inactive-expiring IP records. IP socket and creation limits return 429 with a fixed `Retry-After: 6`; global capacity returns 503. Room and socket leases renew every 60 seconds and expire after 120 seconds without renewal. Releasing a lease immediately frees its capacity and records only its ID and a 120-second expiry in memory, separately for rooms and sockets. Updates are ignored and reacquisition is rejected during that window; late renewals and duplicate releases do not extend an existing record's expiry. Expired release records are collected on subsequent operations and never count toward capacity or per-IP socket limits. CapacityDO restart discards these records and temporarily resets counts; renewal registers existing rooms and sockets again, even above admission limits. A CapacityDO failure or a two-second RPC timeout rejects new admission without closing existing rooms.

Run the local checks before deployment:

```sh
npm run typecheck
npm run check:cloudflare
npm test
npm run test:cloudflare
# Optional local packaging check; does not upload or deploy:
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir dist/cloudflare
```

`test:cloudflare` builds root Web assets and runs the common relay and TypeScript/Go interoperability tests against real local workerd through pinned Miniflare. Additional tests cover routing before authentication, concurrent candidates, DO restarts, capacity failures and lease recovery, security headers, exact asset bytes, alternate hosts, logs and empty local SQLite tables. The compression test connects directly to workerd's Worker socket: the outer Miniflare/Wrangler development proxy can negotiate its own compression independently of the deployed Worker's setting. Virtual clocks and control RPCs exist only in `tests/cloudflare/worker.ts`; `wrangler.jsonc` points to the production entry point, which has none of them.

Authenticate Wrangler with `npx wrangler login` or an appropriately scoped `CLOUDFLARE_API_TOKEN`. Then deploy explicitly:

```sh
npm run deploy:cloudflare
```

This validates the configuration, builds the Web assets and runs the pinned Wrangler deployment. Keep authentication outside source control. Do not use gradual deployments: the internal Worker/DO calls have no version compatibility guarantee. Deploying a new version or restarting a RoomDO invalidates its rooms and active transfers; users must pair with a new QR. A preexisting room cannot be resumed. Keep DO class names stable, and add a Wrangler migration when renaming or removing one.

All requests pass through the Worker, including assets. HTML/API/404 responses have the shared security headers and `Cache-Control: no-store`; hashed assets can be cached immutably. `/` and `/send` map to their built HTML explicitly; missing paths receive 404. Do not introduce `_headers`, SPA fallbacks, extra public hostnames, flags enabling WebSocket compression, or additional service/data bindings. WebSocket compression is explicitly disabled with `no_web_socket_compression` on inbound and outbound connections; modern compatibility dates otherwise enable it automatically. Omit `Sec-WebSocket-Extensions` from Worker and RoomDO upgrade responses and the internal upgrade request, including empty values. `check:cloudflare` rejects manual extension header references in executable relay code. See [Cloudflare compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-compression). The two `new_sqlite_classes` migration entries provision DO namespaces but the application never calls their storage or Alarm APIs.

For a custom domain, disable Rocket Loader, Email Address Obfuscation, automatic Cloudflare Web Analytics injection, Zaraz and other HTML/script rewriting at the zone level for this hostname. Disable JavaScript/Managed Challenges on `/api/v1/rooms` and `/ws`, since the CLI cannot complete them. Let the Worker supply HSTS rather than adding another HSTS policy at the zone.

On `workers.dev`, Cloudflare's shared zone enforces Browser Integrity Check, which account zone settings cannot disable. Some default library User-Agents can receive error 1010 before the Worker runs. The CLI sends `User-Agent: qrtoss/<version>` on both room creation and WebSocket upgrade, following [Cloudflare's guidance to identify the application](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#browser-integrity-check). Confirm the deployed CLI and browser behavior during acceptance; local workerd does not exercise this edge check.

Keep Workers Logs, Logpush and Tail Workers off in either mode. Use `wrangler tail` only briefly for investigation; never add raw requests, exceptions, capabilities, identifiers or message bodies to logs.

The Cloudflare hosting trust boundary includes Cloudflare's TLS termination and delivery of HTML/JavaScript. Endpoints encrypt content, but Cloudflare can observe IP addresses, timings, ciphertext sizes and traffic volume. Zone analytics and security events may record request metadata such as IP, path and User-Agent even with Workers Logs disabled. Disclose this distinction in your privacy policy; application non-persistence does not mean the hosting provider collects no metadata.

The local non-persistence test checks all persisted SQLite tables and scans the files for synthetic transfer secrets. workerd can create empty namespace databases, WAL/SHM files and empty internal alarm metadata without application writes; file existence alone does not establish transfer persistence. Before public operation, also confirm **zero DO storage usage and storage operations** in the deployed account. Do not add KV, D1, R2, Queues, Cache API, Analytics Engine, Hyperdrive, attachment serialization or hibernation APIs.

Use a separate Worker and origin in the chosen hosting mode with production-equivalent settings for manual acceptance. Verify receiver and sender on separate networks, a real `qrtoss --server https://your-host` transfer, deployment/restart recovery, zero storage metrics, security headers on all response classes and exact deployed HTML/JS bytes. The configured custom domain or stable `workers.dev` URL must work; other hosts and version/alias URLs must be disabled or return 404. These account, edge, network and zone checks are not established by local workerd tests. See specification TD03, TD08, TD11, TD12, TD13 and TD15 and [validation status](validation.md).

### Automatic deployment after CI

The CI workflow deploys pushes to `main` after `test`, all three `e2e` browser jobs, and `container` succeed. Pull requests do not deploy. Production deployments run serially.

In the GitHub repository, open **Settings → Environments**, create **production**, and restrict deployment branches to `main`. For unattended deployment, do not enable required reviewers. Configure:

| Location in production | Name | Value |
| --- | --- | --- |
| Environment variables | `PUBLIC_ORIGIN` | `https://qrtoss.<account-subdomain>.workers.dev` or your custom HTTPS origin |
| Environment variables | `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| Environment secrets | `CLOUDFLARE_API_TOKEN` | A scoped Cloudflare API token for Worker deployment |

Create the token in Cloudflare **My Profile → API Tokens → Create Token**, using the **Edit Cloudflare Workers** template and restricting account resources to the target account. The account ID is available from the Cloudflare dashboard. The workflow passes these settings only to the deployment step; the API token is never a Worker runtime binding. Keep the token out of configuration files and source control.

See [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) and [GitHub environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
