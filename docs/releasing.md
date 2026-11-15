# Releasing qrtoss

Release publication, the public service origin, signing identities and a Homebrew tap are maintainer-owned deployment choices. This repository does not pretend that an example domain is a live service.

## Prepare

1. Run the checks in [CONTRIBUTING.md](../CONTRIBUTING.md) and review [validation.md](validation.md). Complete real-phone, terminal and deployment checks before describing a release as supported.
2. Set the intended version in `package.json` and choose a source commit/tag. Pin dependencies and base-image digests; review dependency licenses and advisories.
3. Generate TypeScript/Go shared definitions, confirm no generated drift, and regenerate `THIRD_PARTY_NOTICES` from downloaded dependencies. `npm run notices` requires `GOMODCACHE` and `GOROOT` to point to the module cache and Go distribution whose notices will accompany the release.
4. Configure the CLI's actual public origin during release building. Until a service exists, recipients must provide their own `--server`.

## Build the CLI

With Go on PATH, from the repository root:

```sh
npm run release:cli -- 0.1.0 artifacts/cli
```

Set `QRTOSS_PUBLIC_ORIGIN=https://your-service.example` to embed a real service origin. Set `QRTOSS_DOWNLOAD_BASE_URL` to the HTTPS directory where that exact version's four binaries will be published; the script then also generates `run.sh` with embedded hashes and `qrtoss.rb` for a Homebrew tap. Without a download base it builds binaries/checksums only. `QRTOSS_SIGNING_KEY` optionally points to an existing private key for signing `SHA256SUMS` with OpenSSL. These variables configure a release build; they are not required for local development.

The release script builds CGO-free macOS/Linux binaries for arm64 and amd64, records the version/source commit and generates SHA-256 checksums. Include `LICENSE.md`, `THIRD_PARTY_NOTICES`, the source tag/commit, Go version and support matrix alongside downloadable binaries. A checksum manifest checks integrity; a signed manifest additionally identifies the publisher when users already trust its public key.

## Sign and publish

Keep signing private keys outside this repository. For an existing RSA/ECDSA signing key, an example detached-signature workflow is:

```sh
openssl dgst -sha256 -sign /secure/path/release-key.pem \
  -out artifacts/cli/SHA256SUMS.sig artifacts/cli/SHA256SUMS
openssl dgst -sha256 -verify /trusted/path/release-public.pem \
  -signature artifacts/cli/SHA256SUMS.sig artifacts/cli/SHA256SUMS
```

Distribute the trusted public-key fingerprint through an established independent channel. Do not call hashes obtained together with an executable independent publisher authentication. Do not download and execute an unverified verifier as a substitute for trust.

The version-pinned launcher must use the published release URL and the exact hashes for that release. It preserves CLI argument boundaries and exit status, writes notices only to stderr, never uses sudo or shell `eval`, and caches only verified executable files. Test interruption, partial downloads, hash mismatch, concurrent launch, and unsupported platforms before publishing a launcher endpoint.

After the real distribution URL is chosen, populate the Homebrew formula with exact release URLs and checksums and publish it in the maintainer's tap. Do not ship a formula pointing to placeholder artifacts.

For automated callers, prefer an installed CLI. If using a trial launcher, save the script and confirm download success before executing it. A pipe's exit status alone does not establish that curl completed successfully, and HTTPS script distribution remains a trust boundary.

## Container and source

Build with the reviewed source commit and record the resulting immutable image digest. The reference `Dockerfile` pins the Node base image; `compose.yaml` pins Caddy. Publish source corresponding to generated browser assets and binaries and retain third-party notices.

macOS binaries built from source may need a platform signature/notarization strategy before broad distribution. State the actual signing status and Gatekeeper behavior; an ad-hoc Go linker signature is not Developer ID notarization.
