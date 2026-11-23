# Review service runbook

How to build, publish and serve review packets for review on a laptop, phone or iPad. Everything runs locally from this repository with Node.js 22+. There is no daemon, no cloud service and no public endpoint.

## Threat note

**The review server has no authentication.** Anyone who can reach the address it is bound to can read every packet in the store.

- **Loopback (default):** only this machine can reach it. Use this for review on the laptop itself.
- **Tailscale (recommended for phone and iPad):** only devices on your tailnet can reach it. Tailscale gives you device identity, encrypted transport, and a network that does not include the coffee-shop Wi-Fi.
- **LAN (discouraged):** anyone on the same Wi-Fi or LAN segment can read every packet, and traffic is unencrypted HTTP. Use it only on a network you control, and only when Tailscale is not an option.
- **Never:** wildcard binds (`0.0.0.0`, `::`), public addresses, Tailscale Funnel, or port forwarding. The server refuses the first two, and the last two are out of scope.

## One-time setup

```sh
npm ci --offline          # dev tooling only; the packet runtime needs no dependencies
npm test                  # unit suites: loopback only
npm run test:browser      # Chromium and WebKit suites: loopback only
```

`npm run test:browser` needs Playwright's Chromium and WebKit builds for the pinned `playwright-core` (1.62.1); `npm ci` installs only the library. If they are missing, install them once with `node node_modules/playwright-core/cli.js install chromium webkit`. That command downloads browser builds from the network, so it is not an offline step.

**Which commands bind the tailnet.** `npm test`, `npm run test:browser` and `node scripts/red-controls.mjs` are loopback-only. They run with `CANON_LOOPBACK_ONLY=1`, which makes any non-loopback bind in the process fail instead of listening, so a live test that loses its opt-in gate fails loudly. Only these commands bind this machine's Tailscale address, and only when you run them on purpose:

| Command | What it binds |
| --- | --- |
| `npm run test:tailnet` | live E3 bind test and E5 browser test (`CANON_LIVE_TAILNET=1`) on this machine's Tailscale address, ephemeral ports |
| `npm run proof:tailnet-access` | `scripts/e2e-access.mjs --tailnet`: access and recovery proof on this machine's Tailscale address, port 8791 |
| `npm run service:start:tailscale -- --expect-tailscale-address <address> --expect-tailscale-name <name>` / `canon serve --tailscale` with the same two flags | the review service on the Tailscale address of the node you name |

## Lifecycle

All paths below are gitignored local outputs under `dist/`.

| Step | Command | Notes |
| --- | --- | --- |
| Build, verify, publish and alias in one step | `node src/cli.mjs review <report.json> --store dist/review-store --alias <name>` | Writes `dist/builds/build-<utc>-<pid>/` plus its build receipt. Publish and alias receipts go in `dist/review-store/receipts/`. The alias update is compare-and-swap on the generation just read. |
| The fixture | `npm run review:fixture` | Alias `phase1-review`. |
| Build only | `node src/cli.mjs build <report.json> --out <dir> --receipt <file>` | `<dir>` must not exist. Its parent must exist. |
| Verify | `node src/cli.mjs verify <packet-dir>` | Exit 1 on any mismatch. Never repairs. |
| Publish | `node src/cli.mjs publish <packet-dir> --root dist/review-store --build-receipt <file>` | Idempotent for identical bytes. A conflicting stored packet fails. |
| Alias | `node src/cli.mjs alias set <name> <content-id> --root dist/review-store --expect-generation <n>` | `0` creates the alias. A stale generation fails. |
| Start, loopback | `npm run service:start` (`--port 8791`) | Prints JSON with the URL. Returns once `/healthz` answers. Idempotent if already running. A start that names an expected Tailscale node is answered by a running service only if that service runs on that node and was started with the same expectation; otherwise the start is refused and the running service is left running (`service stop` first). |
| Start, Tailscale | `npm run service:start:tailscale -- --expect-tailscale-address <address> --expect-tailscale-name <name>` | Binds the Tailscale IPv4 of the node you name and allows its MagicDNS name. Loopback is not bound in this mode. Without the two flags it is refused and binds nothing. |
| Start, custom | `node src/cli.mjs service start --root <store> --state-dir <dir> --port <n> [--host <ip> \| --tailscale --expect-tailscale-address <address> --expect-tailscale-name <name>] [--allow-host <name>]` | `--host` must be an IP literal. |
| Health and readiness | `npm run service:status` | Exit codes: `0` running and healthy, `1` stopped, `2` stale state (process gone), `3` unhealthy, `5` orphaned (a server still answers at the recorded URL, but the recorded pid is not this service), `6` state file corrupt. |
| Stop | `npm run service:stop` | Sends SIGTERM, waits, and escalates to SIGKILL only for the proven service process. |
| Restart | `npm run service:restart` | Stops and restarts with the saved `config.json`. Recovers stale state. The saved config is checked first: if it can no longer be started (a `--tailscale` start saved before the expected node existed, or the `tailscale` CLI now answering for another node), the restart is refused and the running service is left running. Stop it and start it again with the two flags. |
| Residue cleanup | `npm run service:clean` | See "Cleanup scope". |
| Foreground serve | `node src/cli.mjs serve --root dist/review-store --port 8791 [--tailscale --expect-tailscale-address <address> --expect-tailscale-name <name>]` | Ctrl-C to stop. Same bind policy. |

### URLs

- **Alias (always current, never cached):** `http://<host>:<port>/a/<name>/`. It returns a 307 redirect to the immutable packet.
- **Immutable packet:** `http://<host>:<port>/p/<content-id>/`
- **Agent-readable Markdown (coequal entry point):** `http://<host>:<port>/a/<name>/report.md` (307, never cached) or immutable `http://<host>:<port>/p/<content-id>/report.md`. `manifest.json` names it in `agentEntry`. Block anchors are `[<id>]: #<id>` lines under headings, with the same ids as `index.html#<id>` (decisions D10).
- **Inventory and digests:** `/p/<content-id>/manifest.json` and `/p/<content-id>/checksums.json`
- **Alias record:** `/a/<name>.json`
- **Readiness:** `/healthz`

On this machine:

- **Tailscale:** `http://<tailscale-address>:8791/a/phase1-review/`, or by name `http://<machine>.<tailnet>.ts.net:8791/a/phase1-review/`; agents: `http://<machine>.<tailnet>.ts.net:8791/a/phase1-review/report.md`
- **Loopback:** `http://127.0.0.1:8791/a/phase1-review/`

Other services on this machine hold ports 8787 and 8794, so do not use those.

## Bind policy (what `--host`/`--tailscale` accept)

- **Default:** `127.0.0.1`. `::1` is also accepted.
- **`--tailscale`:** always with the two `--expect-tailscale-*` flags below; alone it is refused, because the CLI would be choosing the node. The address comes from `tailscale ip -4`. It is checked against `tailscale status --json`, where the backend must be `Running` and the address must be in `Self.TailscaleIPs`. The MagicDNS name (`Self.DNSName`) is added to the Host allowlist.
- **`--expect-tailscale-address <ipv4> --expect-tailscale-name <dns-name>`** (given together, required with `--tailscale`): the node you expect. Read them with `tailscale ip -4` and from `Self.DNSName` in `tailscale status --json` (drop the trailing dot), using the same `tailscale` CLI the service will find. A machine can run more than one Tailscale node, and which one the `tailscale` CLI answers for depends on `PATH` and on how it finds its daemon socket. With these flags the service refuses, before it listens, unless the CLI answers for exactly that address and that `Self.DNSName`. `service start` saves the expectation, the serve process checks it again, and `service restart` reuses it, so a discovery that changes later is refused too. They also work with `--host <that address>`.
- **`--host <ip>`:** must be an IP literal assigned to a local interface, and one of:
  - this machine's Tailscale address;
  - a private LAN address (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) on a non-tunnel interface.
- **Always refused:**
  - wildcards;
  - public and link-local addresses;
  - hostnames;
  - addresses not on this machine;
  - any `100.64.0.0/10` address that is not the Tailscale address;
  - any address on a tunnel interface (`utun`, `tun`, `tap`, `wg`, `ppp`, `ipsec`) other than Tailscale's. On this machine a second tunnel interface holds another `100.x` address. It is refused unless it is the node you name with the two `--expect-tailscale-*` flags.
- **Host allowlist:** requests are served only when `Host` is the bound `address:port`, `localhost:<port>` (loopback binds only), or an allowed name at that port (the MagicDNS name, or `--allow-host` values). Everything else gets `421 Misdirected Request`. This defeats DNS rebinding.

## Recovery

- **Service crashed (for example, killed).**
  - Symptom: `service:status` exits `2` (stale).
  - Recovery: `npm run service:restart`, or `service:start`. Stale state is detected by pid identity and cleared automatically, and an event is logged.
- **Stale state from a recycled pid.** The state file is trusted only if its pid's command line is this directory's `cli.mjs serve`. An unrelated process with the same pid is never signalled.
- **Orphaned server (`status` exits `5`).** The state file names a pid that is not this service, yet a server still answers at the recorded URL; this happens with a tampered or recycled state file. `start`, `stop` and `restart` refuse (exit `5`) and keep the state file. Find the listener with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, confirm it is `cli.mjs serve` for this store, stop it by hand, then remove `dist/service/state.json`.
- **State file corrupt (exit `6`, `state-corrupt`).**
  - Symptom: `state.json` stays unparseable after repeated reads. The service writes it atomically, so this means something else wrote to it or the disk failed.
  - What happens: `start`, `status`, `stop` and `restart` refuse and keep the file for inspection. A `start` that meets it while waiting for readiness stops the child it spawned.
  - Recovery: read the file, then confirm with `lsof -nP -iTCP:<port> -sTCP:LISTEN` that no `cli.mjs serve` for this state directory is still running (stop it by hand if one is), then remove `dist/service/state.json`.
- **Port already in use.**
  - Symptom: `service start` exits `4` with `port-in-use: <addr>:<port> is in use by <command> (pid N)`.
  - Recovery: pick another `--port`. Do not kill processes you do not own.
- **Service unhealthy (`status` exits `3`).** Run `npm run service:restart`, then read `dist/service/server.log`.
- **Alias locked (`alias-locked`).** A writer crashed while holding `<store>/aliases/<name>.lock`. The lock file holds the pid of the writer that made it. Read that one number (`cat <store>/aliases/<name>.lock`) and look at that one process (`ps -p <pid> -o command=`). If it prints nothing, or shows a command that is not an `canon alias` or `canon review` writer, the writer is gone: remove that one lock file by hand. Do not list every process on the machine to find out. `service:clean` reports locks but never removes them.
- **Packet will not serve (500 integrity failure).** The stored bytes no longer match the manifest. Do not repair the file in place. Run `node src/cli.mjs verify dist/review-store/packets/<id>`, then republish from a verified build.

## Logs and evidence

| What | Where |
| --- | --- |
| Server stdout/stderr (request log as JSON lines), appended, never truncated | `dist/service/server.log` |
| Lifecycle events: start, ready, stop, restart, recovered-stale-state, start-refused, clean | `dist/service/events.jsonl` |
| Current process (pid, URLs, allowed Hosts, root) | `dist/service/state.json`; present only while running, published atomically (never half-written) |
| Last start configuration | `dist/service/config.json` |
| Receipts: build, publish, alias | Build: next to each build directory. Publish and alias: `dist/review-store/receipts/` |
| Proof evidence | `evidence/<run>/`: output of local proof runs, git-ignored; see `evidence/README.md`. Never cleaned. |

## Cleanup scope

`npm run service:clean` removes only:

- the service state file, when its process is gone;
- `<store>/.staging/<content-id>.<pid>.<rand>` directories left by publisher processes that are no longer running.

It never removes packets, aliases, alias locks, receipts, logs, `evidence/**`, or tracked files. It refuses to run against any path that is tracked or not gitignored. To reclaim space, remove whole `dist/` subdirectories by hand after stopping the service, and only if you no longer need their packets.
