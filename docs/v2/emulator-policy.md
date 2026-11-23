# Publisher V2: emulator policy

This document says what the local mocks may be used to claim, what they may not, and what would have to change before a third-party emulator (such as Miniflare) is admitted.

**Sources:** research `docs/v2/research/cloudflare-adapter.md` §3.10 (CF).

## 1. What runs in this phase

**The only provider is an in-repo mock.** It is a plain module under `src/publication/mocks/`: `cloudflare-worker.mjs`, a Worker over R2, D1 and Access.

**The adapters reach them only through `InProcessTransport`.** The protocol, adapters and CLI make no socket, no provider SDK call and no emulator process. The static gate and the runtime guard hold this (R77).

**The one socket is test-only.** `test/unit/v2-serving-harness.test.mjs` puts each mock's serving handler behind a Node HTTP server on `127.0.0.1` with an ephemeral port, so the V2-7 header and route contract is checked over real HTTP. That server belongs to the test, not to `src/`. It binds loopback only, never 0.0.0.0, a tailnet address, or ports 8787 or 8794.

**No emulator is installed or downloaded:**

- `wrangler`, Miniflare and `workerd` are all absent;
- installs are `npm ci --offline`;
- whether a later phase may download them is maintainer decision 6 in [architecture.md](architecture.md).

## 2. Rules for mocks

1. **Model the documented contract, cite it, and mark the unverified.** Each mock's header comment lists the behaviours it models with the research section. Behaviour the research marks **unverified** is modelled conservatively (for example, a sha256 mismatch is rejected even though the production error text is unknown, CF §3.1), and the mock says so.
2. **Mock-only instrumentation is named and never trusted by product code.**
   - The simulated client timeout is status 599.
   - These are listed as deviation 12 in [architecture.md](architecture.md).
   - No production code path may depend on them to decide correctness.
3. **Faults are injected at the mock endpoint, with one vocabulary across adapters.** The vocabulary is: throttle, timeout, failPuts, failPutsAfter, corruptReads, staleAliasReads, failReceipts, raceAliasWrite (a competing promotion committed between a writer's read and its conditional write), `respond` rules (answer the next matching request with a given status, instead of processing it or after committing it: a lost response), failHistoryAppend and failAliasWrite (fs: real permission failures on the V1 history log and the aliases directory) and token expiry. The fs adapter takes the same faults through a wrapper, and a fault with no fs analogue is reported NOT_APPLICABLE, not PASS.
4. **Mocks may be stricter than the provider, never looser.** A mock that accepted what the provider rejects would let a defect through. For example, the mock refuses a Worker DELETE.
5. **A mock must be able to fail its own contract test.** Every modelled precondition has a red control that removes it and must turn a test red:
   - R69: create-if-absent;
   - R74: CAS;
   - R91, R92: serving headers and routes.

   A mock behaviour with no red control is not evidence.

**The deployable Worker is tested under Node, not `workerd`.**

- `src/publication/worker/index.mjs` runs against in-process fakes in `test/v2/worker-bindings.mjs`:
  - an R2 bucket following the documented binding semantics, with **no delete method**;
  - a D1 database that executes the Worker's real SQL on Node's built-in `node:sqlite`, with `batch()` as a transaction;
  - a fake Access edge that mints RS256 JWTs.
- No `workerd` or Miniflare is installed or downloaded.
- A run on the real Workers runtime is **NOT_EXECUTED**, a provider-evidence cell. That includes the real R2 checksum error and the Access certs fetch.

## 3. What mock evidence may claim

**Mock evidence may claim:**

- that the client (protocol, adapters, policy, CLI) behaves correctly **against the documented provider contract as modelled**, including under every injected fault;
- that the serving logic produces the V1 headers, routes and status codes.

**Mock evidence may not claim anything about real providers.** Every provider-evidence cell in the proof matrix is **NOT_EXECUTED (provider evidence required)**, never PASS. That covers:

- **R2:** `onlyIf` atomicity under real concurrent writers.
- **D1:** behaviour under read replication.
- **Access:** policy evaluation.
- **The rest:** TLS, DNS, caches and billing.

This applies equally to a future third-party emulator: a single-node emulator is trivially consistent, and it cannot prove concurrency or edge behaviour (CF §3.10).

## 4. Admitting a third-party emulator later

Admitting an emulator requires separate maintainer authority, because it is a new download. If admitted, it enters as a **transport**, not as a replacement for the contract suite:

1. **A new transport class** (for example `LoopbackEmulatorTransport`) behind the same interface, added to the static-gate allowlist by name. Its endpoint must be a loopback address the transport verifies at construction.
2. **A self-test that must fail on a non-conforming emulator,** run before any contract row counts:
   - R2 `onlyIf` on an existing key must be refused;
   - a wrong sha256 must be refused.

   This is required, not optional.
3. **The same contract suite and red controls,** run against the emulator transport. Its cells are recorded as emulator evidence, distinct from both mock evidence and provider evidence.
4. **Candidate:**
   - **Miniflare / `workerd`:** its R2 simulator implements `onlyIf` and digest checks (CF §3.10 [S24]). Bucket-lock simulation is unverified.
