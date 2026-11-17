# Validation and release acceptance

The implementation includes automated tests and a CI workflow. Automated desktop browsers and synthetic camera streams do not establish compatibility with real phone cameras, OS camera-to-browser handoff, every terminal, or a deployed HTTPS host.

## Automated checks

| Area | Check |
| --- | --- |
| Shared definitions | `npm run check:generated`; TS/Go output generated from `protocol/` |
| Type/static checks | `npm run typecheck`, `npm run lint`, `go vet ./...` and pinned `staticcheck ./...` in `cli/` |
| Formatting | `npm run format:check`; `gofmt -l .` in `cli/` must report no files |
| Crypto | Appendix A proof/ciphertext fixtures, tampering, canonical encodings, sequence replay, Unicode limits |
| Relay | Real HTTP/WS authentication, capabilities, candidate/commit/ready lifecycle, roles, expiry, rate/capacity/size bounds, shutdown and static security headers |
| Web | Content classification, language keys/error messages, control schemas, base-path validation and URL generation, camera QR input, confirmation before send, display-only and same-tab auto-open flows |
| CLI | Output encoding, strict options, crypto, single-message receipt, duplicate suppression, output/ack ordering and termination |
| Interoperability | Actual TypeScript client and Go receiver with isolated TLS transport; no production TLS bypass |
| Browsers | `npm run test:e2e`: Chromium, Firefox and WebKit with synthetic camera frames; root and `/qrtoss/` builds behind a prefix-stripping HTTP/WebSocket test proxy |
| Dependency checks | `npm audit`, `govulncheck ./...` in `cli/` |
| Distribution | Four CGO-free CLI build targets; Dockerfile/Compose checks in CI |

CI is a recipe, not a claim that a remote workflow has already run. Consult actual command output and release evidence when evaluating a particular commit.

## Local implementation verification

During initial implementation on macOS arm64, Node.js 26.13.0 and Go 1.27.4 were used. The 36 Node unit/integration/interoperability tests, eight Chromium/WebKit browser tests, TypeScript/i18n/generated-definition checks, production build, Go race tests and Go vet passed. All four CLI target binaries and version-pinned launcher/formula generation were built locally. Browser tests exercised actual QR decoding from synthetic camera streams, camera-track shutdown, CSP without violations, no content storage and explicit confirmation before transfer.

Firefox could not launch its temporary test profile in this macOS environment; its tests remain configured in CI and are not claimed as locally passed. Docker image/Compose execution and real-phone/terminal support checks remain unverified here.

The npm dependency audit reported no vulnerabilities. Go vulnerability analysis reported no reachable vulnerable symbols or imported vulnerable packages; its module-level report identified GO-2026-5024 in the Windows-only portion of `golang.org/x/sys v0.33.0`, which this macOS/Linux-only CLI does not import. Re-run both audits at release time; these results are not a permanent security guarantee.

## Browser subpath implementation verification

For the browser subpath implementation, all 38 Node unit/integration/interoperability tests passed, along with generated-definition, i18n and TypeScript checks and production builds for both `/` and `/qrtoss/`. All 16 Chromium and Firefox E2E tests passed across the two deployment paths. These tests exercised actual QR decoding through the Worker, prefix-stripping HTTP/WebSocket forwarding, encrypted transfer, pairing-fragment removal and home navigation.

WebKit could not launch because required host shared libraries were unavailable, including after a temporary local dependency setup; its eight E2E tests are therefore unverified, rather than product test failures. The actual Apache configuration, TLS deployment and real-phone behavior were not verified in this environment.

## Review fixes 3.1 and 3.2 verification

All 49 Node unit/integration/interoperability tests passed, including actual Go receiver tests for delayed commit notifications crossing the QR deadline and late proofs followed by server-driven QR renewal. Relay tests inject a monotonic clock to check ready exchange across the pairing deadline. IP tests cover IPv6 /64 and configurable /56 aggregation, non-byte-aligned prefixes, IPv4-mapped spellings, proxy trust, shared authentication/socket limits and LRU eviction at 4,096 entries. TypeScript, generated-definition and i18n checks, the production build, Go race tests and Go vet also passed.

All 28 Chromium and Firefox E2E cases passed across the root and `/qrtoss/` deployments, including the four commit-boundary cases rerun after correcting the test clock setup. The new browser tests hold commit/proof notifications and advance client/server clocks to exercise QR and candidate deadline boundaries. WebKit still cannot launch because host shared libraries are missing; its 14 E2E cases remain unverified. Real-phone and deployed HTTPS checks remain required.

## Go formatting and lint CI verification

CI checks Go formatting and runs Staticcheck v0.8.2 before Node and browser tests. With Go 1.26.2 locally, both added CI scripts, `go test -race -count=1 ./...` and `go vet ./...` passed. The workflow YAML and added shell scripts also passed syntax checks. Isolated fixtures confirmed that formatted, lint-clean Go passes, while unformatted files, parse errors and unused code fail the corresponding checks. Three unchecked `Seal()` errors in the crypto tests were fixed after Staticcheck reported them.

## CLI room close cleanup verification

The CLI attempts `room.close` once per receiver session, including when the write fails, and retains the original termination reason. Six regression cases cover command timeout, protocol violation and local idle expiry, each with successful and failed writes followed by deferred cleanup. All Go race tests, Go vet, formatting checks, Staticcheck v0.8.2 and the 12 real Go CLI interoperability tests passed.

## Cloudflare Durable Objects implementation verification

The Node and Cloudflare adapters now share the room state machine, protocol validation, expiry, rate limits, close behavior and security headers in `packages/relay-core/src/`. Worker, RoomDO and CapacityDO keep their state only in memory. Wrangler 4.164.0, Miniflare 5.20261117.0-beta (the version used by that Wrangler), Cloudflare types 5.20261117.1 and the compatibility date are pinned.

On Linux amd64 with Node.js 26.13.1 and Go 1.26.2, `npm test` passed all 159 tests and `npm run test:cloudflare` passed all 47 tests. The Cloudflare run uses actual local workerd through Miniflare and reuses the relay suite and all 12 Go CLI scenarios, plus the TypeScript encrypted-transfer test. Additional cases cover explicit refusal of offered WebSocket compression on the native workerd Worker socket (bypassing the development proxy's independent compression negotiation), invalid first traffic without a RoomDO upgrade, unknown/closed rooms, simultaneous candidates, RoomDO/CapacityDO aborts, valid close propagation, created-room loss, admission failures/timeouts, authentication promotion, lease recovery at 60 seconds, route/host/header/asset checks and non-persistence. Virtual clock/control RPCs are confined to a test entry point that is absent from the production deployment.

The local persistence check found empty room SQLite databases, empty internal alarm tables and SQLite WAL/SHM metadata created by workerd. All tables contained zero rows, and neither files nor captured runtime logs contained the synthetic plaintext, ciphertext, identifiers, capabilities or PSK. `npm run check:cloudflare` checks executable source for forbidden storage, Alarm, attachment, hibernation, cache and logging references, verifies platform-independent imports, and restricts deployment bindings/configuration. These checks run in CI.

TypeScript checks for both runtimes, lint, formatting, generated definitions, i18n, production builds and Wrangler's deployment dry run passed. All 16 Chromium E2E cases passed for root and subpath Node deployments. The production entry point was also started with `npm run dev:cloudflare` through actual Wrangler: HTTPS health/API routes, exact `/` and `/send` HTML bytes, real encrypted Unicode transfer, ack/ack_seen and room closure passed. The local command disables route-based origin inference to preserve the configured loopback origin.

The production dependency audit reported zero vulnerabilities. The full dependency audit still reports the existing picomatch/Vite development-tool chain advisory already documented in CI; the added Cloudflare dependencies introduced no additional audit findings.

No Cloudflare account deployment, cross-network real-device test, deployed CLI session, zone rewrite/challenge setting, workers.dev/preview hosting setting or production storage metric was verified. TD03, the deployment part of TD08, the production part of TD11/TD12/TD13 and TD15 still require the separate staging/custom-domain evidence described in the specification and [operations](self-hosting.md#cloudflare-workers-and-durable-objects). Firefox and WebKit were not rerun for this change. Local success does not claim public deployment or completion of those manual acceptance items.

## Required manual release evidence

- iPhone/iPad Safari and Android Chrome: standard-camera connection handoff, permissions, rear camera, scanner Worker path, sleep/background/resume and explicit external-app opening.
- Actual terminal apps on macOS/Linux, both CPU architectures: compact/full QR readability, colors, ambiguous character widths, redirected stdout, non-TTY stderr and SSH.
- A real HTTPS self-hosted deployment: certificate trust, reverse-proxy WebSocket handling, configured Origin, CSP, restart behavior, no payload capture or persistent transfer storage.
- A subpath browser deployment: `/qrtoss/` receiver, `/qrtoss/send` pairing handoff, camera decoder assets, home navigation and HTTP/WebSocket forwarding through the actual Apache configuration. Automated proxy tests do not validate a host's Apache configuration or TLS certificates.
- Signed release assets, independent public-key instructions, launcher failure/concurrency behavior and Homebrew installation after real distribution URLs are selected.
- Independent protocol/implementation review and accurate disclosure of external audit status.

These manual checks are not completed by running the automated suite. This initial development session does not claim an externally audited or publicly deployed release. The local environment has no running Docker daemon/Compose plugin, so container execution must be verified in CI or on a Docker host.
