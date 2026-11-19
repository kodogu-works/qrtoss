<h1>
  <img src="docs/assets/qrtoss-logo.svg#gh-light-mode-only" alt="qrtoss" width="216" height="48">
  <img src="docs/assets/qrtoss-logo-dark.svg#gh-dark-mode-only" alt="qrtoss" width="216" height="48">
</h1>

[日本語](README.ja.md)

[![CI](https://github.com/kodogu-works/qrtoss/actions/workflows/ci.yml/badge.svg)](https://github.com/kodogu-works/qrtoss/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Go](https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Author](https://img.shields.io/badge/author-Synge%20Todo-blue)](https://github.com/wistaria)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)

Send a QR code's contents from your phone to another browser or a terminal. Connect by scanning a temporary QR code, scan the code you want to transfer, review it, and send. No account, installed phone app, or shared Wi-Fi is needed.

The receiver can display the original text or open HTTP(S) URLs in the same tab. The Go CLI writes **received text (such as a URL) to stdout, then exits**. Connection QR codes, expiry times, and diagnostics go to stderr; routine connection and receipt logs are suppressed. The web interface supports English, Japanese, and Spanish; CLI messages are in English.

## Run locally

Requirements: Node.js 26 (tested with 26.13.0), npm, and Go 1.24+ for the CLI (tested with 1.27.4).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:8080**. This loopback development server is suitable for testing two browsers on your computer. It is not a phone-accessible camera deployment: phones need a reachable HTTPS origin with a trusted certificate. The development command builds frontend assets at startup; restart it after frontend edits.

## Self-host with HTTPS

Point a domain at your host and allow inbound ports 80 and 443. With Docker Engine and Compose installed:

```sh
cp .env.example .env
# Set PUBLIC_ORIGIN in .env to your real https:// origin (no trailing slash).
docker compose up -d --build
```

Open that HTTPS origin on the receiving device. Scan its connection QR with the phone's standard camera, open the sender page, choose **Scan a QR code**, review the result, and choose **Send to receiver**. Opening a web URL ends the connection. Display-only mode keeps the connection available for further transfers.

The app runs as one non-root process with an in-memory room map and a read-only filesystem. Only Caddy exposes public ports; only Caddy's TLS certificate storage is persistent. See [self-hosting and operations](docs/self-hosting.md) for configuration, proxy trust, host memory settings, updates, and troubleshooting.

Without Docker:

```sh
npm run build
PUBLIC_ORIGIN=https://qr.your-domain.example NODE_ENV=production npm start
```

Place the internal HTTP listener behind a trusted HTTPS/WSS reverse proxy. HTTPS is mandatory in production. No database, Redis, STUN, or TURN service is required.

For a browser deployment under an existing site's `/qrtoss/` path, build with:

```sh
QRTOSS_BASE_PATH=/qrtoss/ npm run build
```

Keep `PUBLIC_ORIGIN` set to the origin only, for example `https://myserver.example`. Configure Apache to remove `/qrtoss` before forwarding HTTP and WebSocket requests to the app. See the [Apache subpath deployment instructions](docs/self-hosting.md#browser-deployment-under-an-apache-subpath) for the complete configuration. The base path is fixed at build time; the default is `/`. The CLI and the supplied Docker Compose/Caddy setup continue to use the origin root.

## Cloudflare hosting

The relay also runs on Cloudflare Workers and Durable Objects with the same browser and CLI protocol. Choose a custom domain or a `workers.dev` URL and set the matching `PUBLIC_ORIGIN` in `wrangler.jsonc`, run `npm run test:cloudflare`, then deploy with `npm run deploy:cloudflare`. For local workerd use `npm run dev:cloudflare`. See [Cloudflare setup, privacy and operations](docs/self-hosting.md#cloudflare-workers-and-durable-objects).

For `workers.dev`, deploy without editing the config: `PUBLIC_ORIGIN=https://qrtoss.my-account.workers.dev npm run deploy:cloudflare`. The script generates and validates a temporary config; the Worker name must match `wrangler.jsonc`. Add `-- --dry-run` to package without deploying.

## CLI

Try the CLI without building it (macOS/Linux, arm64/amd64). Replace `https://qr.your-domain.example` with your deployment’s public origin (`PUBLIC_ORIGIN`) that serves `run.sh` and the CLI binaries:

```sh
curl -fsSL https://qr.your-domain.example/run.sh | sh
```

Pass CLI options after `sh -s --`:

```sh
curl -fsSL https://qr.your-domain.example/run.sh | sh -s -- --timeout 120
curl -fsSL https://qr.your-domain.example/run.sh | sh -s -- --qr full
curl -fsSL https://qr.your-domain.example/run.sh | sh -s -- --qr off
curl -fsSL https://qr.your-domain.example/run.sh | sh -s -- --jsonl > received.jsonl
```

`--qr off` prints the connection URL instead of a QR. The launcher downloads and caches the binary for your platform and forwards CLI options. This executes a script from the distribution service; use it only if you trust that service. For automation, run an installed CLI directly, or use the following command to run the script only if the download succeeds:

```sh
curl -fsSL https://qr.your-domain.example/run.sh -o qrtoss-run.sh &&
  sh qrtoss-run.sh --timeout 120
```

Build the standalone executable from source:

```sh
cd cli
go build -trimpath -o qrtoss ./cmd/qrtoss
./qrtoss --server https://qr.your-domain.example
```

The built-in example origin is not an operating public service. Set `--server` or `QRTOSS_SERVER` to your deployment. The CLI and phone must both be able to reach that origin.

```sh
./qrtoss --server https://qr.your-domain.example > received.txt
url="$(./qrtoss --server https://qr.your-domain.example --timeout 120)"
./qrtoss --server https://qr.your-domain.example --jsonl > received.jsonl
./qrtoss --help
```

Text output is the unmodified received string followed by LF. Text containing control characters is rejected with exit code 6; use `--jsonl` for arbitrary valid Unicode, embedded newlines, or controls. JSONL outputs one object, `{"text":"…"}`, followed by LF. The CLI never opens URLs or evaluates received text.

Connection QRs expire after 60 seconds. Before receiving an item, the CLI refreshes expired pairing information and can recover from connection loss. `--timeout` limits the wait until an output-capable item is accepted, not a slow stdout write. After output, delivery confirmation and shutdown take at most two seconds; uncertain acknowledgement delivery does not turn successful output into an error. See [the specification](docs/spec.md#14-cli受信クライアント) for exact options and exit codes.

Use an adequately wide terminal; `--qr full` can help if compact QR characters look distorted. `--pairing-url` explicitly permits printing the secret connection URL. Use `--qr off` to disable QR rendering and automatically enable `--pairing-url`; this also works with non-TTY stderr. Keep this URL private and avoid combining stdout and stderr when capturing output.

## Development and verification

```sh
npm run gen:protocol
npm run check:generated
npm run typecheck
npm run lint
npm run check:i18n
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
cd cli
go test -race ./...
go vet ./...
```

`protocol/` contains language-independent constants, error codes, close reasons, and published test vectors. Generated TypeScript/Go constants are checked for drift. Tests cover published crypto vectors, malformed inputs, actual relay sockets, simulated QR camera input, and cross-language transfer. See [validation status](docs/validation.md) for the distinction between automated verification and release acceptance.

Release tooling creates the four macOS/Linux arm64/amd64 executables, checksum manifests, and version-pinned launcher scripts. See [release instructions](docs/releasing.md). There is no published download endpoint or signed release provided by this checkout.

## Security and privacy

Clients derive separate directional keys using HKDF-SHA256 and encrypt messages with AES-256-GCM after mutual proof verification. The relay sees connection metadata and ciphertext, not the pairing secret or plaintext. Rooms, keys, and deduplication records are transient; there is no transfer database, offline queue, telemetry, or external runtime CDN.

The pairing QR grants access: do not share it. Encryption depends on trustworthy client code and devices. Source availability does not prove that a particular host serves that source. The protocol and implementation have not received an independent external security audit. See [SECURITY.md](SECURITY.md) and [the full specification](docs/spec.md).

## License

[MIT](LICENSE.md), copyright © 2026 Synge Todo. Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
