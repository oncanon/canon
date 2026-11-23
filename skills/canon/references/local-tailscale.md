# Local and Tailscale Visibility

## Machine Profile & Operator Authority Split

Workstation serving state lives in `~/.canon/` (or `$CANON_HOME/`):

- `~/.canon/profile.json` (`profile/v1`) — **Operator / `CanonBar.app` owned.** Defines standing workstation `exposure` (`"tailscale"` | `"local"` | `"stopped"`), `port`, `storeRoot`, `stateDir`, `buildsDir`, and pinned `tailscale` node `{ address, name }`.
- `~/.canon/store/` — Canonical immutable edition store (`packets/`, `aliases/`, `receipts/`).
- `~/.canon/service/` — Live listener state (`state.json`, `config.json`, `server.log`, `events.jsonl`).
- `~/.canon/builds/` — Scratch build directories and build receipts.

### Strict Agent Rules

1. **Read status first:** Run `canon status` to inspect the active profile, whether the server is `running` or `stopped`, the active `preferredBaseUrl` (`http://<machine>.<tailnet>.ts.net:<port>` or `http://127.0.0.1:<port>`), and existing aliases.
2. **Never mutate `profile.json`:** Agents must never create, edit, or overwrite `~/.canon/profile.json`. Exposure selection belongs exclusively to the operator via `CanonBar.app` (or explicit operator shell action).
3. **Never auto-start or escalate a stopped server:** Publishing (`canon brief`, `canon sitrep`, `canon publish`, `canon alias set`) writes to the store only. If `canon status` shows `service.state` is `"stopped"` (or `profile.exposure` is `"stopped"`), publish the edition to the store if requested, report the store paths/content ID, and inform the user that the server is currently stopped in `CanonBar` — do **not** run `canon service start` unless the user explicitly instructs you to manage the daemon.

## Inspecting Status and Aliases

```sh
canon status
canon alias list
canon alias get <alias>
```

When `canon status` reports `"state": "running"`, `canon brief` and `canon sitrep` automatically return a populated `urls` object (`humanAlias`, `agentAlias`, `humanImmutable`, `agentImmutable`) matching the active listener. Verify reader access directly against those URLs:

```sh
curl -fsS "<baseUrl>/healthz"
curl -fsSI "<humanAlias>"
curl -fsSL "<agentAlias>" -o /tmp/readback.md
```

## Operator Manual Service Commands (Only When Explicitly Instructed)

### Local only (`127.0.0.1`)

```sh
canon service start \
  --root <store> \
  --state-dir <state-dir> \
  --port <port>

canon service status --state-dir <state-dir>
```

Only this machine can reach loopback (`http://127.0.0.1:<port>/a/<alias>/`).

### Tailscale (`--tailscale` with pinned node expectation)

`--tailscale` refuses to bind unless the caller explicitly names the expected Tailscale IPv4 and MagicDNS hostname (`Self.DNSName` without trailing dot):

```sh
canon service start \
  --root <store> \
  --state-dir <state-dir> \
  --tailscale \
  --expect-tailscale-address "<address>" \
  --expect-tailscale-name "<machine>.<tailnet>.ts.net" \
  --port <port>
```

Discover the current machine's values with `tailscale ip -4` and `tailscale status --json` (`Self.DNSName`, stripped of any trailing `.`). Never fabricate a hostname.

Stop and recover:

```sh
canon service stop --state-dir <state-dir>
canon service restart --state-dir <state-dir>
```

Interpret `service status` exit codes: `0` healthy, `1` stopped, `2` stale, `3` unhealthy, `4` port in use, `5` orphaned, `6` corrupt state. Never kill an unknown listener.

## Security Boundary Statement

Always state clearly when reporting a Tailscale URL:

- Canon adds no application login screen.
- Anyone permitted by tailnet connectivity/ACLs to reach the bound address can read every edition in the store.
- Wildcard (`0.0.0.0`, `::`), public, hostname, and link-local binds are refused by the server.
