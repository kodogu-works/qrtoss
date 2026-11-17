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

No Cloudflare account deployment, cross-network real-device test, deployed CLI session, zone rewrite/challenge setting, workers.dev/preview hosting setting or production storage metric was verified. TD03, the deployment part of TD08, the production part of TD11/TD12/TD13 and TD15 still require separate staging evidence in the chosen hosting mode, as described in the specification and [operations](self-hosting.md#cloudflare-workers-and-durable-objects). Firefox and WebKit were not rerun for this change. Local success does not claim public deployment or completion of those manual acceptance items.

## Worker relay send-volume review fix (7.3)

Worker and RoomDO sockets enforce a lifetime allowance of 4,325,376 UTF-8 bytes per send direction, including 4,096 bytes reserved for closing notifications. Every text message counts, including authentication, heartbeat and touch traffic. Time, successful sends and candidate replacement do not replenish the allowance. Exceeding it drops the message and closes with `SLOW_PEER` and code 1008; the Node adapter retains its `bufferedAmount` check. Long-running normal sessions or repeated retries can also reach this limit and require a new QR.

TD16 connects directly to local workerd, bypassing the test fixture's draining WebSocket proxy. Four cases pause the actual TCP reader while still sending heartbeat and touch, exercise both s2r and r2s, and separately exhaust RoomDO output with maximum-size ciphertext and Worker input with whitespace-padded messages. They verify bounded output including closure, close code/reason, and continued encrypted communication in another room. Another case completes 100 maximum-text transfers with status, ack and ack_seen. Core tests cover exact allowance/reserve boundaries and exhaustion by heartbeat replies alone without `bufferedAmount`.

On Linux amd64 with Node.js 26.13.1 and Go 1.26.2, `npm test` passed all 161 tests and `npm run test:cloudflare` passed all 53 tests, including all 12 real Go CLI scenarios on each adapter. TypeScript checks for both runtimes, lint, formatting, generated-definition checks, Cloudflare non-persistence checks, the production build and Wrangler's deployment dry run passed. These checks use local workerd; no staging deployment or real-device/browser test was performed for this fix.

## WebSocket subprotocol review fix (7.4)

Both adapters use `acceptsWebSocketProtocol()` from the shared HTTP module and require exactly one `qrtoss.v1` offer, allowing only surrounding HTTP spaces and tabs. Missing, empty, mismatched, combined or duplicate offers return 400 (`VERSION_UNSUPPORTED`) before socket admission. The existing per-IP capacity responses remain 503 (`CAPACITY`) on Node and 429 (`RATE_LIMITED`, `Retry-After: 6`) on Cloudflare; the specification now states this difference explicitly.

The common relay regression sends raw HTTP upgrades to check 12 invalid cases, including repeated header lines, plus successful single offers with and without whitespace and the selected response header. For Cloudflare it connects directly to workerd, bypassing Miniflare's WebSocket client parsing and the fixture's proxy. TD04 also checks the JSON error and zero consumed CapacityDO socket leases. The previous Worker accepted `qrtoss.v1, other.v1` with 101 and failed the new regression; the corrected implementation returns 400.

On Linux amd64 with Node.js 26.13.1 and Go 1.26.2, `npm test` passed all 162 tests and `npm run test:cloudflare` passed all 55 tests, including all 12 real Go CLI scenarios on each adapter. Both runtime type checks, lint, formatting, generated-definition checks, Cloudflare non-persistence checks and the production build passed. These are local checks; the staging and real-browser acceptance items remain pending.

## WebSocket extension header review fix (7.6)

Removed empty `Sec-WebSocket-Extensions` headers from the public Worker upgrade response, internal Worker-to-RoomDO upgrade request and RoomDO upgrade response. Compression remains disabled by the pinned `no_web_socket_compression` flag. TD04 offers `permessage-deflate` directly to workerd and now requires the response header to be `undefined`; an empty value fails. `check:cloudflare` also rejects extension header references in executable relay code, so workerd's removal of empty headers cannot conceal their reintroduction. The check rejected the previous bridge code and passed after removal. The specification and hosting instructions now describe the same policy.

On Linux amd64 with Node.js 26.13.1 and Go 1.26.2, `npm run test:cloudflare` passed all 55 tests, including all 12 real Go CLI scenarios. Both runtime type checks, lint, formatting, Cloudflare non-persistence/deployment checks, the Web build and Wrangler's deployment dry run passed. No staging deployment or real-browser acceptance was performed for this fix; those remain the review 7.8 acceptance items.

## Capacity lease release ordering review fix (7.5)

CapacityState records released room and socket IDs separately in memory for 120 seconds. It ignores renewals and rejects reacquisition of a recorded ID, including when release arrives before the lease is registered. Release immediately frees the active lease; release records contain only IDs and expiry times and do not count toward room, socket, unauthenticated or per-IP capacity. Late renewals and duplicate releases do not extend an existing record's expiry. Subsequent operations collect expired records, and CapacityDO restart discards them along with other volatile state. Existing lease recovery after restart still bypasses admission caps.

Core regressions cover both release/update orders, previously registered and unknown leases, both socket authentication states, fresh admission, the 120-second expiry boundary, duplicate releases and independent room/socket ID namespaces. TD10 delivers room/socket renewal RPCs through another stub after release in real local workerd. Counts remain zero, and fresh room creation, receiver authentication and heartbeat succeed with room, socket, unauthenticated and per-IP limits set to one. Before the fix, the room count returned to one and the new test failed. The ordering control RPC exists only in the test entry point.

On Linux amd64 with Node.js 26.13.1 and Go 1.26.2, `npm test` passed all 165 tests and `npm run test:cloudflare` passed all 56 tests, including all 12 real Go CLI scenarios on each adapter and the existing CapacityDO restart/recovery and non-persistence tests. Both runtime type checks, lint, formatting, generated-definition checks, Cloudflare static checks, the Web build and Wrangler's deployment dry run passed. No staging deployment or real-device acceptance was performed.

## Specification record reconciliation (7.7)

Specification 17.1 now lists the implemented Web, Node, Cloudflare, shared-module, Go CLI, generator and test paths, including the root `wrangler.jsonc`. It describes the root npm package and `cli/` Go module. All 46 listed repository paths and 74 relative file links in the three changed documents were checked against the repository; obsolete layout names were removed from the section.

The ten official Cloudflare references S37–S46 were revisited on 2026-11-17 (America/Chicago). Specification 20 records the date and reviewed topics: object identity and lifecycle, WebSocket APIs and hibernation, static asset routing, plan/usage limits, timers, client-IP headers, logging and compression flags. The existing confirmation note for S37–S45 was already present when this correction began. Documentation review does not add staging, cross-network or real-device test results; those remain the review 7.8 acceptance items.

## workers.dev hosting selection

Cloudflare deployments can select a custom domain or the stable `https://<worker-name>.<account-subdomain>.workers.dev` URL. The configuration check enforces one exact HTTPS origin, matching Worker name and account hostname in `workers.dev` mode, no custom routes in that mode, and one matching custom-domain route with `workers_dev: false` in custom-domain mode. It rejects mixed hosting, mismatched names, version-prefixed URLs, non-default ports and path suffixes. Preview URLs, application logging and WebSocket compression remain disabled in both modes.

Three configuration regression groups cover both modes and invalid settings. TD12/TD13 runs encrypted Unicode transfer, ack and ack_seen with a `workers.dev` public origin in local workerd, checks exact HTML and shared security headers, and rejects alternate hosts and mismatched request Origins. The Go CLI sends `User-Agent: qrtoss/<version>` on room creation and WebSocket upgrade; the HTTP boundary test and actual TLS/Go interoperability test verify those headers. The [deployment guide](self-hosting.md#cloudflare-workers-and-durable-objects) and specification 10.2, 16.10 and 18.7 describe the settings and edge behavior.

On Linux amd64 with Node.js 26.13.1 and Go 1.26.2, all 168 Node tests and all 57 Cloudflare tests passed, including all 12 actual Go CLI scenarios on each adapter. The final configuration fixtures also passed after being made independent of the operator's selected hosting mode. Both runtime type checks, lint, formatting, generated definitions, i18n, Cloudflare static checks, the production build, Go race tests, Go vet and Staticcheck v0.8.2 passed. Wrangler's deployment dry run packaged both hosting configurations with the production entry point and assets; nothing was uploaded or deployed.

These local checks do not establish deployed `workers.dev` routing, Cloudflare's Browser Integrity Check, deployed CLI/browser connections or the pending review 7.8 acceptance items. No Cloudflare account deployment or real-device test was performed for this change.

## Required manual release evidence

- iPhone/iPad Safari and Android Chrome: standard-camera connection handoff, permissions, rear camera, scanner Worker path, sleep/background/resume and explicit external-app opening.
- Actual terminal apps on macOS/Linux, both CPU architectures: compact/full QR readability, colors, ambiguous character widths, redirected stdout, non-TTY stderr and SSH.
- A real HTTPS self-hosted deployment: certificate trust, reverse-proxy WebSocket handling, configured Origin, CSP, restart behavior, no payload capture or persistent transfer storage.
- A subpath browser deployment: `/qrtoss/` receiver, `/qrtoss/send` pairing handoff, camera decoder assets, home navigation and HTTP/WebSocket forwarding through the actual Apache configuration. Automated proxy tests do not validate a host's Apache configuration or TLS certificates.
- Signed release assets, independent public-key instructions, launcher failure/concurrency behavior and Homebrew installation after real distribution URLs are selected.
- Independent protocol/implementation review and accurate disclosure of external audit status.

These manual checks are not completed by running the automated suite. This initial development session does not claim an externally audited or publicly deployed release. The local environment has no running Docker daemon/Compose plugin, so container execution must be verified in CI or on a Docker host.
