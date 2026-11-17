# Contributing

Use Node.js 26 and Go 1.24 or later. Start with [docs/spec.md](docs/spec.md); security-sensitive wire changes must be reflected in the shared definitions, both clients, tests and documentation.

```sh
npm ci
npm run gen:protocol
npm run typecheck
npm run lint
npm run format:check
npm run check:i18n
npm test
npm run build
npm run test:e2e
```

Install test browsers with `npx playwright install chromium firefox webkit`. In `cli/`, run `go generate ./...`, `go test -race ./...`, and `go vet ./...`. Review `npm run check:generated` output before submitting.

The browser base path defaults to `/`; build a subpath deployment with `QRTOSS_BASE_PATH=/qrtoss/ npm run build`. Keep URL construction in the shared browser path helper and preserve immediate pairing-fragment removal. Browser tests cover root and subpath builds using a prefix-stripping HTTP/WebSocket proxy. The Node relay and CLI retain root routes; see [the Apache deployment instructions](docs/self-hosting.md#browser-deployment-under-an-apache-subpath) before changing deployment behavior.

Run `npm run format` to format handwritten TypeScript and JavaScript with Biome. `npm run lint` performs Biome's recommended static checks and fails on warnings; `npm run check` remains a separate TypeScript type check. CI checks both lint and formatting. The scope is recorded in `biome.json`; generated protocol constants are excluded and remain verified by `check:generated`. Existing non-null assertions at DOM/protocol boundaries and explicit `any` in wire/test helpers are permitted; new code should prefer precise types. Keep mechanical formatting separate from behavior changes in commits.

For Go, CI requires `gofmt -l .` to report no files and runs Staticcheck on all packages, including tests. Use `gofmt -w .` in `cli/` to apply formatting. Install and run the same pinned Staticcheck version as CI from `cli/`:

```sh
go install honnef.co/go/tools/cmd/staticcheck@v0.8.2
staticcheck ./...
```

`web/src/main.ts` removes the pairing fragment immediately and chooses the page. Keep sender camera/delivery state in `sender.ts`, receiver QR/receipt/navigation state in `receiver.ts`, and shared markup/rendering in `view.ts`. Page state belongs to each initializer, rather than shared module globals.

Keep protocol constants, control-message schemas, and fixtures in `protocol/`; do not edit generated files. Edit `protocol/control-messages.json` for control wire shapes, field types/ranges, and target endpoints, then run `npm run gen:protocol` and `npm run check:generated`. Error-code and close-reason enums reference their existing JSON definitions. The TypeScript control validator is shared by relay and Web; Go uses generated validation tables. Keep authorization, peer binding, and session state checks in the respective session implementations. Update the independent examples in `protocol/vectors/control.json` and run both TypeScript and Go tests whenever the schema changes. Use only synthetic data in fixtures and failure artifacts. Keep ja/en/es UI and CLI dictionaries synchronized. Pin direct dependency versions, update lockfiles, check licenses and vulnerabilities, and update third-party notices when dependencies change.

Relay state transitions live in `packages/relay-core/src/`; both `server/src/` and `server/cloudflare/src/` must use them. Keep Node imports and `ws` out of the shared core and Cloudflare adapter. Hashing/comparison interfaces are asynchronous: finish all awaits before rechecking and changing room state. Run `npm run check:cloudflare` and `npm run test:cloudflare` for relay changes, alongside the Node suite. The latter executes real local workerd, the common relay tests, and the actual Go receiver against the Cloudflare adapter. Test control routes and virtual clocks belong only in the separate test entry point. Never use DO persistence, alarms, socket attachments, hibernation or payload logging; preserve the Wrangler binding allowlist and the pinned runtime/tool versions.

Explain the resulting behavior and relevant tests in pull requests. Follow the existing MIT license for contributions. Do not include third-party code without its license and required notices. Report security issues using [SECURITY.md](SECURITY.md), not public reproduction with live secrets.
