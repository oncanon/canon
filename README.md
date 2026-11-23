# Canon (`canon`)

Canon turns a structured technical brief (`report/v1` JSON plus evidence files) or multi-page SitRep (`site-input/v1` JSON) into an immutable, content-addressed edition. Each edition has a human web page and a coequal agent-readable Markdown file. It serves them locally or over Tailscale for review on a laptop, an iPhone or an iPad.

It exists so that a reviewer and an agent see identical verified bytes, can prove they are identical, and can find them again under a stable name.

Everything runs locally with Node.js 22+. It needs no cloud service, and nothing is published automatically.

## Agent skill

The installable Agent Skills package at
[`skills/canon`](skills/canon/SKILL.md)
teaches coding agents to build and share Canon briefs and SitReps while distinguishing local-only,
Tailscale, Cloudflare-private and Cloudflare-public visibility.

Install it from this repository with an Agent Skills-compatible installer:

```sh agent-skill-install
npx skills@latest add OWNER/canon
```

The installer discovers the skill under `skills/` and lets the user choose the
target coding agents. A local agent working in this checkout may also read the
skill directly. Installing the skill grants no publication or cloud authority.

## What it guarantees

- **Immutable, content-addressed packets.**
  - A packet's content ID is `sha256-<hex>` of its canonical manifest. Every file is listed there with its size and SHA-256.
  - Publishing the same bytes again is a no-op. Publishing different bytes under an existing ID fails, and the stored packet is not changed.
- **Aliases are separate.** An alias (for example `phase1-review`) is a small mutable record outside the packet that points at one content ID. It is updated by compare-and-swap on its generation, and it never changes packet bytes.
- **Two coequal artifacts from one source.** `index.html` (human) and `report.md` (agent) are both generated from the same validated report. The manifest names `index.html` as `entry` and `report.md` as `agentEntry`.
- **Fail-closed validation and parity.**
  - An invalid report fails the build.
  - `verify` recomputes every digest and the content ID, exits 1 on any mismatch, and never repairs.
  - The server re-hashes every file before sending it and refuses a mismatch.
  - Parity tests check that every source element appears in both artifacts, inside the same anchored block.
- **Local and offline.**
  - A packet loads nothing third-party and makes no external request: Libron is vendored as fingerprinted local WOFF2 assets, while its Content-Security-Policy blocks script, frames and outbound connections.
  - Nothing leaves the machine unless you copy it.

## Quick start (five minutes)

Run from the repository root. This block is executed verbatim by `test/unit/e9-readme.test.mjs`, except that `PORT` is set to a free ephemeral port. A comment `# exit N` gives the expected non-zero exit code.

```sh
npm ci --offline
mkdir -p dist
node src/cli.mjs build fixtures/report/phase1-review.report.json --out dist/packet --receipt dist/build-receipt.json
node src/cli.mjs verify dist/packet
node src/cli.mjs publish dist/packet --root dist/review-store --build-receipt dist/build-receipt.json
CONTENT_ID=$(node -p "require('./dist/packet/manifest.json').contentId")
node src/cli.mjs alias set phase1-review "$CONTENT_ID" --root dist/review-store --expect-generation 0
PORT=8791
node src/cli.mjs service start --root dist/review-store --state-dir dist/service --port "$PORT"
node src/cli.mjs service status --state-dir dist/service
curl -fsS "http://127.0.0.1:$PORT/healthz"
curl -fsSL -o dist/review.html "http://127.0.0.1:$PORT/a/phase1-review/"
curl -fsSL -o dist/review.md "http://127.0.0.1:$PORT/a/phase1-review/report.md"
shasum -a 256 dist/review.md dist/packet/report.md
node src/cli.mjs service stop --state-dir dist/service
node src/cli.mjs service status --state-dir dist/service  # exit 1
node src/cli.mjs service restart --state-dir dist/service
kill -9 "$(node -p "require('./dist/service/state.json').pid")"
node src/cli.mjs service status --state-dir dist/service  # exit 2
node src/cli.mjs service restart --state-dir dist/service
node src/cli.mjs service stop --state-dir dist/service
```

What each step does:

1. **Install** installs dev tooling only (`playwright-core`, `axe-core`, `commonmark`). The builder, verifier and server use only the Node.js standard library. `build --out` needs the output directory's parent to exist, hence `mkdir -p dist`.
2. **Build, verify, publish, alias** creates the packet, checks it, stores it under its content ID, and points the alias at it.
3. **Serve** starts a detached service on `127.0.0.1` and returns once `/healthz` answers. Then check health with `status` (exit 0) and `/healthz`, and read both artifacts through the alias into `dist/`, which is gitignored, so the quick start leaves the working tree clean. `dist/review.md` is byte-identical to the built `report.md`, whose SHA-256 is in `dist/packet/manifest.json`.
4. **Recover** covers stop (status then exits 1), restart, and a crash (`kill -9` leaves stale state, so status exits 2). The final restart detects the stale state, clears it, and brings the service back.

Shortcuts for the same steps:

- `npm run brief:fixture` builds, verifies, publishes and sets the alias in one step.
- `npm run service:start`, `npm run service:status`, `npm run service:stop` and `npm run service:restart` use `dist/review-store`, `dist/service` and port 8791.

## Output contract

### Routes

Every response carries the security headers listed under [Serving and security](#serving-and-security). The first four packet rows are covered by `verify` and the per-request re-hash.

| Request | Status | Content-Type | Cache-Control |
| --- | --- | --- | --- |
| `GET /p/<content-id>/` | 200 | `text/html; charset=utf-8` | `public, max-age=31536000, immutable` |
| `GET /p/<content-id>/report.md` | 200 | `text/markdown; charset=utf-8` | `public, max-age=31536000, immutable` |
| `GET /p/<content-id>/manifest.json` | 200 | `application/json` | `public, max-age=31536000, immutable` |
| `GET /p/<content-id>/checksums.json` | 200 | `application/json` | `public, max-age=31536000, immutable` |
| `GET /p/<content-id>/report.md` with `If-None-Match: "<sha256>"` | 304 | none | `public, max-age=31536000, immutable` |
| `GET /p/<content-id>` | 308 to `/p/<content-id>/` | `text/plain; charset=utf-8` | `public, max-age=31536000, immutable` |
| `GET /a/<name>/` | 307 to `/p/<content-id>/` | `text/plain; charset=utf-8` | `no-store` |
| `GET /a/<name>/report.md` | 307 to `/p/<content-id>/report.md` | `text/plain; charset=utf-8` | `no-store` |
| `GET /a/<name>.json` | 200 | `application/json` | `no-store` |
| `GET /healthz` | 200 | `text/plain; charset=utf-8` | `no-store` |
| `GET /healthz` with `Host: example.invalid` | 421 | `text/plain; charset=utf-8` | `no-store` |
| `POST /healthz` | 405 | `text/plain; charset=utf-8` | `no-store` |
| `GET /p/<content-id>/missing.txt` | 404 | `text/plain; charset=utf-8` | `no-store` |

- **Human:** the alias URL `/a/<name>/`, which always shows the current packet, or the immutable `/p/<content-id>/`.
- **Agent:** the alias URL `/a/<name>/report.md`, or the immutable `/p/<content-id>/report.md`.
- An alias redirect is never cached. Resolve it once, then keep the immutable URL.
- Each packet file's `ETag` is `"<sha256>"` from the manifest.

### Identity and read-back

- `manifest.json` lists every file: `path`, `role`, `mediaType`, `bytes`, `sha256`.
- `contentId` is the SHA-256 of the canonical manifest without its own ID.
- `checksums.json` repeats the digests for simple checking.
- `node src/cli.mjs verify <packet-directory>` recomputes all of it.
- The published copy is read back and verified before publish reports success.
- Receipts (build, publish, alias) are written outside the packet and never affect identity.

### Agent Markdown (`report.md`)

- **Structure:**
  - real CommonMark/GFM: headings in document order, lists, fenced code with a language info string, GFM tables, and emphasis/strong from the source;
  - chart values as tables, and diagram steps as ordered lists.
- **Anchors:**
  - each summary, section, finding, decision, risk, figure and evidence heading is followed by a reference-definition line such as `[f-F-1]: #f-F-1`;
  - the id is the same block's id in `index.html`, so `report.md#f-F-1` and `index.html#f-F-1` name the same block;
  - the manifest records the convention as `agentEntry.anchors: "reference-definitions/1"`.
- **Escaping:** only where a character would otherwise be parsed as syntax in that exact place, so ordinary prose, paths, identifiers and numbers read cleanly. Identifier placeholders such as `<sha256>` appear as code spans.
- **Safety:** authored text can never produce raw HTML, images, links or code-fence break-outs.

Design and rationale: [contract decisions](docs/decisions/phase1-contract.md), especially D2 (layout), D10 (anchors) and D11 (escaping).

## Serving and security

- **No authentication.** Anyone who can reach the bound address can read every packet in the store.
- **Loopback by default.** A non-loopback bind must be asked for with `--host <ip>` or `--tailscale`.
- **Always refused:** wildcard binds (`0.0.0.0`, `::`), public and link-local addresses, hostnames, and addresses that are not on this machine.
- **Tailscale (recommended for phone and iPad):**
  - only devices on your tailnet can reach the service;
  - access control is tailnet membership, and this project has not inspected the tailnet's ACLs;
  - `--tailscale` binds this machine's Tailscale IPv4 only (not loopback) and allows its MagicDNS name;
  - `--tailscale` must come with the node you expect, `--expect-tailscale-address` and `--expect-tailscale-name`. A machine can run more than one Tailscale node, and any node other than the one you name is refused before the service listens. Read the address with `tailscale ip -4` and the name from `Self.DNSName` in `tailscale status --json`, without its trailing dot.
- **LAN (`--host <private-ip>`):** discouraged. It is plain HTTP, and anyone on the same network can read every packet.
- **Host allowlist:** a request whose `Host` is not the bound address, `localhost` on a loopback bind, or an allowed name gets 421. This defeats DNS rebinding.

Tailscale example. Run **one** of the two commands below; they are equivalent.

**Opt-in: binds this machine's Tailscale address. Never part of the default tests.**

Either the npm script:

```sh opt-in-tailnet
npm run service:start:tailscale -- --expect-tailscale-address "<address>" --expect-tailscale-name "<machine>.<tailnet>.ts.net"
```

or the same command written out:

```sh opt-in-tailnet
node src/cli.mjs service start --root dist/review-store --state-dir dist/service --tailscale --expect-tailscale-address "<address>" --expect-tailscale-name "<machine>.<tailnet>.ts.net" --port 8791
```

Then open `http://<machine>.<tailnet>.ts.net:8791/a/phase1-review/` on the phone or iPad, or `http://<machine>.<tailnet>.ts.net:8791/a/phase1-review/report.md` for agents.

Every response carries these headers:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |

The page has no JavaScript. The same policy, minus `frame-ancestors` (which browsers ignore in a `<meta>` tag), is also in the page's `<meta>` tag, so a packet opened from disk is equally restricted.

## Reviewing on laptop, iPhone and iPad

The page is one static HTML file with one fingerprinted stylesheet. The browser suites check it in Chromium and WebKit at these sizes:

| Viewport | Size |
| --- | --- |
| phone | 390x844 |
| ipad-portrait | 820x1180 |
| ipad-landscape | 1180x820 |
| laptop | 1440x900 |

- **Layout (P11):**
  - no sideways page scroll: wide tables and code scroll inside their own boxes;
  - touch targets are sized for fingers;
  - landscape iPad and laptop get a side contents rail.
- **Reflow and zoom (P11):** usable at 200% zoom and at 320px width.
- **Print (P12):** claims, evidence references, URLs, code and tables stay legible; only navigation is hidden.
- **Accessibility (P13):** axe-core finds no WCAG 2.2 A/AA violations in light and dark schemes. Keyboard navigation, the skip link, visible focus, landmarks and heading order are checked.
- **Code (Variant A):** restrained presentation, with a language label, line numbers that are not copied with the code, and line anchors. The derivation is in [docs/design/variant-a-provenance.md](docs/design/variant-a-provenance.md).
- **Real devices:** engine-level WebKit runs are not a physical iPhone or iPad. The on-device check is a separate manual step.

## Operations

The runbook, [docs/operations/review-service.md](docs/operations/review-service.md), covers the full lifecycle, recovery and cleanup. File locations:

| Path | Contents |
| --- | --- |
| `dist/packet/` | A built packet (any `--out` directory) |
| `dist/build-receipt.json` | Build receipt (outside the packet) |
| `dist/review-store/packets/` | Published packets, one directory per content ID |
| `dist/review-store/aliases/` | Alias records (`<name>.json`) |
| `dist/review-store/receipts/` | Publish and alias receipts |
| `dist/service/state.json` | The running service: pid, URLs, allowed hosts. Present only while it runs |
| `dist/service/config.json` | Last start configuration, reused by restart |
| `dist/service/server.log` | Server stdout and stderr, appended, never truncated |
| `dist/service/events.jsonl` | Lifecycle events: start, ready, stop, restart, recovery |
| `evidence/README.md` | Placeholder: new runs write their evidence under `evidence/` (git-ignored) |

`node src/cli.mjs service status --state-dir dist/service` exits with:

| Exit | Service state |
| --- | --- |
| 0 | running and healthy |
| 1 | stopped |
| 2 | stale: the recorded process is gone |
| 3 | unhealthy: the process runs but `/healthz` does not answer |
| 4 | port in use (from `service start`) |
| 5 | orphaned: a server answers at the recorded URL, but the recorded pid is not this service |
| 6 | state file corrupt (unparseable after retries) |

`build`, `verify`, `publish` and `alias` exit with:

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 1 | failure: invalid report, digest mismatch, conflicting publish, stale alias generation |
| 2 | usage error: no command, an unknown command or subcommand, a missing required argument (the usage text is printed), or an unknown flag (a one-line error naming the flag, no usage text), for example `verify --bogus x` |

Recovery:

- **Port in use (exit 4):** choose another `--port`. Do not kill processes you do not own.
- **Stale state (exit 2):** `service restart` or `service start` clears it. A pid is only ever signalled after its command line proves it is this state directory's server.
- **State file writes are atomic:** a torn read is retried. A file still unparseable at the end gives exit 6 and is kept for inspection.
- **Orphaned (exit 5):** find the listener with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, stop it by hand, then remove the state file.
- **Cleanup:** `npm run service:clean` removes only stale service state and staging directories left by dead publishers. It never removes packets, aliases, alias locks, receipts, logs, `evidence/` run output or tracked files.

## Development and verification

Default commands (loopback only):

```sh
npm test
npm run test:browser
node scripts/red-controls.mjs
```

**Opt-in: binds this machine's Tailscale address. Run it deliberately, never as part of the commands above.**

```sh opt-in-tailnet
npm run test:tailnet
```

**Browser prerequisite.** `npm run test:browser` needs Playwright's Chromium and WebKit builds for the pinned `playwright-core` (1.62.1). `npm ci` installs only the library. On a machine without them, install them once with Playwright's own installer. **This downloads browser builds from the network**, so it is not part of any offline step:

```sh
node node_modules/playwright-core/cli.js install chromium webkit
```

- **`npm test`:** the unit, integration and property suites. Loopback only: with `CANON_LOOPBACK_ONLY=1`, any non-loopback bind fails instead of listening.
- **`npm run test:browser`:** the Chromium and WebKit suites. Loopback only; covers the viewports above, print, accessibility, zero external requests, CSP, and parity between the source, the HTML and `report.md`.
- **`npm run test:tailnet`:** opt-in, in its own labelled block. It binds this machine's Tailscale address for the live bind and device-URL tests.
- **`node scripts/red-controls.mjs`:** re-runs each red control. A red control deliberately reintroduces a known defect in a scratch copy of the repository. It counts as red when the mutation applies, a mutated JavaScript file still parses (`node --check`), the tests pass before the mutation, and the named test files exit non-zero after it. A failure while the mutated module loads also counts (residual D-G2), so check the listed failing tests to see where it went red.
- **How `report.md` is validated:**
  - its structure is derived from the report source and compared with the parse under commonmark 0.31.2 and pandoc 3.5 (`-f gfm`);
  - its anchors are compared with the HTML ids;
  - every escape is judged by a per-character parser oracle;
  - seeded property runs cover segment boundaries across thousands of cases.
  
  Details: [contract decisions](docs/decisions/phase1-contract.md) D10 and D11.

## Scope and known residuals

**Scope.**

- Local by default. Canon also has a Cloudflare Worker target and a private VPS setup. Remote work runs only one run at a time with the maintainer's go-ahead, as [AGENTS.md](AGENTS.md) sets out. There is no automatic publication.
- The original phased plan is in [docs/projects/review-packet-publisher.md](docs/projects/review-packet-publisher.md). It is history; [AGENTS.md](AGENTS.md) sets what is authorized now.

**Known residuals at this commit:**

- **No authentication** beyond reaching the bound address. On Tailscale that means tailnet membership; tailnet ACLs have not been inspected.
- **D-G1 (low).** A character reference split across two authored text segments (`a &amp` then `; b`) renders `a & b` in `report.md`.
- **D-G2 (low to medium).** The red-control harness checks that a mutation parses, not that the mutated module loads.
- **Parser coverage.**
  - GitHub's cmark-gfm is not tested; pandoc 3.5 `-f gfm` stands in for it.
  - Reference-definition anchors do not become heading ids in GitHub or pandoc renderings, so `report.md#<id>` does not scroll there.
- **Dependency pinning.** The `commonmark` dev dependency uses a caret range.
- **Carried Phase 1 QA items:**
  - **D1b:** the proof scripts' refuse-to-overwrite guard uses `git ls-files`, so in a `git archive` extraction (no `.git`) it fails open. Generate new evidence only in a git checkout.
  - **R1:** the print rule that expands the label legend uses `::details-content`. Browsers without it (older Safari/iOS, untested Firefox) print the legend collapsed.
  - **D2:** the P8 malicious-corpus suite does not emit a per-case JSON artifact; the per-case results are in the test-event log.
  - **D4:** some CLI errors print a stack trace (a refused bind), though the exit code is correct.
  - **D5:** contents numbering (01–09) differs from section heading numbering (00–05, Ev, A, Pv).
  - **D6:** the chart's data table has no accessible name.
  - **`Range`:** HTTP `Range` requests are ignored and return the full body with 200.

**Reporting an issue.** Open an issue on the project's repository with:

- the commit (`git rev-parse HEAD`);
- the content ID (`dist/packet/manifest.json` or the `X-Content-Id` response header);
- the exact command and its exit code;
- stdout and stderr;
- for the service, the tails of `dist/service/server.log` and `dist/service/events.jsonl`;
- the output of `node src/cli.mjs verify <packet-directory>`.

## Architecture

```text
report/v1 JSON + evidence files
        |  validate (fail closed)
        v
  build: index.html + report.md + assets + evidence
        |  canonical manifest -> content ID (sha256-...)
        v
  verify -> publish: store/packets/<content-id>/ (immutable, read back)
        |
        v
  alias: store/aliases/<name>.json (compare-and-swap) --> one content ID
        |
        v
  serve (loopback | Tailscale): /a/<name>/ and /a/<name>/report.md (307, no-store)
                                /p/<content-id>/... (immutable, re-hashed)
        |
        v
  readers: laptop, iPhone and iPad browsers; agents via report.md and manifest.json
```
