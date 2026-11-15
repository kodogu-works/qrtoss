# Security

qrtoss is an initial implementation of the protocol in [docs/spec.md](docs/spec.md). No independent external security audit has been completed.

Report security issues privately to the maintainer, Synge Todo, at **wistaria@phys.s.u-tokyo.ac.jp**. Include the affected commit/version, reproduction steps with synthetic data, and impact. Do not include real pairing URLs, payloads, secrets, tokens, heap dumps or production packet captures in a public issue. If the repository has private vulnerability reporting enabled, that channel is also appropriate.

The current development version is the supported security target. A public stable release support policy will be recorded when releases are published.

## Trust boundary

Clients perform mutual PSK-based proof verification and derive separate AES-GCM keys for each direction. The relay forwards ciphertext immediately to the connected peer and maintains only transient room/capability state. It cannot recover the PSK from a room API request because the receiver generates it locally and passes it to the sender only in a URL fragment. The fragment is removed from the sender page immediately.

The pairing QR grants access and must be kept private. Browsers, standard camera apps and terminal scrollback may retain information independently of qrtoss. Explicit CLI `--pairing-url` output and stdout redirection are user-controlled local outputs, not private application storage.

E2EE does not protect against compromised endpoints or malicious JavaScript/binaries supplied by a compromised distributor. Source/version identifiers aid inspection; they do not attest to the deployed code. Source availability and AGPL/MIT licensing do not provide such attestation.

No history database, offline queue, analytics, remote translation or runtime external CDN is used. Host swap, core dumps, snapshots, proxy payload capture and third-party hosting logs are deployment responsibilities; see [operations](docs/self-hosting.md).

## Development constraints

Do not add logging of payloads, ciphertext, keys, complete pairing URLs, capability tokens or raw parse exceptions. Validate external schemas, canonical encodings, limits, roles, sequences, deadlines and generation after asynchronous operations. Use platform cryptographic primitives. Preserve the published protocol vectors and run cross-language, browser and real-device checks before release.
