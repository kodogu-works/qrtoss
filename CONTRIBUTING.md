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

Keep protocol constants, control-message schemas, and fixtures in `protocol/`; do not edit generated files. Edit `protocol/control-messages.json` for control wire shapes, field types/ranges, and target endpoints, then run `npm run gen:protocol` and `npm run check:generated`. Error-code and close-reason enums reference their existing JSON definitions. The TypeScript control validator is shared by relay and Web; Go uses generated validation tables. Keep authorization, peer binding, and session state checks in the respective session implementations. Update the independent examples in `protocol/vectors/control.json` and run both TypeScript and Go tests whenever the schema changes. Use only synthetic data in fixtures and failure artifacts. Keep all registered Web dictionaries synchronized; CLI presentation is English-only. Pin direct dependency versions, update lockfiles, check licenses and vulnerabilities, and update third-party notices when dependencies change.

Relay state transitions live in `packages/relay-core/src/`; both `server/src/` and `server/cloudflare/src/` must use them. Keep Node imports and `ws` out of the shared core and Cloudflare adapter. Hashing/comparison interfaces are asynchronous: finish all awaits before rechecking and changing room state. Run `npm run check:cloudflare` and `npm run test:cloudflare` for relay changes, alongside the Node suite. The latter executes real local workerd, the common relay tests, and the actual Go receiver against the Cloudflare adapter. Test control routes and virtual clocks belong only in the separate test entry point. Never use DO persistence, alarms, socket attachments, hibernation or payload logging; preserve the Wrangler binding allowlist and the pinned runtime/tool versions.

Explain the resulting behavior and relevant tests in pull requests. Follow the existing MIT license for contributions. Do not include third-party code without its license and required notices. Report security issues using [SECURITY.md](SECURITY.md), not public reproduction with live secrets.

## Adding a UI language

The Web UI currently supports English, Japanese, and Spanish. Translations live in
`web/src/locales/en.ts`, `ja.ts`, and `es.ts`. Each file exports `label` (the language
name shown in the selector), `messages` (UI text, including help and accessibility
labels), and `errorMessages` (messages keyed by error code). English defines the
required keys; `web/src/locales/types.ts` derives `Messages` and `ErrorMessages` from
it. `web/src/i18n.ts` provides the registry, language selection, interpolation, and
error lookup. CLI output remains English-only.

1. Copy `web/src/locales/ja.ts` to a file named for the new base language code, for
   example `web/src/locales/fr.ts`. Keep the `Messages` and `ErrorMessages` type
   annotations. Translate `label`, every `messages` value, and every
   `errorMessages` value. Keep keys, protocol error codes, and placeholders such as
   `{seconds}` unchanged. Use the language's own name for `label`, for example
   `Français`. Complete the translations before registering the language.
2. Import the module in `web/src/i18n.ts` and add it to `locales`:

   ```ts
   import * as french from './locales/fr';

   export const locales = { en: english, ja: japanese, es: spanish, fr: french };
   ```

   `Language`, UI dictionaries, error lookup, language-selector options, and the
   translation check all derive from this registry. No manual `<option>` or
   separate list in the check script is needed.
3. Language selection prefers a saved manual choice, then the first supported
   browser preference, then English. Browser preferences are matched by their
   lower-case base code (`fr-CA` matches `fr`). Use a base code in the registry;
   regional variants need an explicit change to `chooseLanguage`. Add a case in
   `tests/web/i18n.test.ts` for the new language and its browser preference.
4. With Node.js 26, run:

   ```sh
   npm run check
   npm run check:i18n
   node --import tsx --test tests/web/i18n.test.ts
   npm run lint
   npm run format:check
   npm run build:web
   ```

   The type check catches missing and extra keys in typed dictionaries. The
   translation check checks all registered languages for matching UI keys,
   nonempty values, matching placeholders, and translations for every code in
   `protocol/error-codes.json`.
5. Check the receiver and sender in a browser, including help, errors, narrow
   screens, keyboard operation, and long text. Confirm that switching language
   preserves the connection, QR code, received content, and camera state, and that
   the choice survives reload. For a right-to-left language, also implement and
   verify document direction; changing `lang` alone does not set `dir`.
6. Update the supported-language descriptions in `README.md`, `README.ja.md`,
   `docs/design.md`, and `docs/spec.md`. A translated README is not required to
   add a UI language.

When adding a UI message, add its English key and translate it in every registered
locale. When adding a protocol error, update `protocol/error-codes.json`, follow
its generation and protocol-test workflow above, and add the keyed translation to
every locale's `errorMessages`.
