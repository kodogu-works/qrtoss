# Contributing

Use Node.js 26 and Go 1.24 or later. Start with [doc/spec.md](doc/spec.md); security-sensitive wire changes must be reflected in the shared definitions, both clients, tests and documentation.

```sh
npm ci
npm run gen:protocol
npm run typecheck
npm run check:i18n
npm test
npm run build
npm run test:e2e
```

Install test browsers with `npx playwright install chromium firefox webkit`. In `cli/`, run `go generate ./...`, `go test -race ./...`, and `go vet ./...`. Review `npm run check:generated` output before submitting.

Keep protocol constants and fixtures in `protocol/`; do not edit generated files. Use only synthetic data in fixtures and failure artifacts. Keep ja/en/es UI and CLI dictionaries synchronized. Pin direct dependency versions, update lockfiles, check licenses and vulnerabilities, and update third-party notices when dependencies change.

Explain the resulting behavior and relevant tests in pull requests. Follow the existing MIT license for contributions. Do not include third-party code without its license and required notices. Report security issues using [SECURITY.md](SECURITY.md), not public reproduction with live secrets.
