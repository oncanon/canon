# Cloudflare visibility

Cloudflare has two materially different modes. Never collapse them into “cloud.” Read the current runbook and live project status before acting:

- private: `docs/v2/cloudflare/runbook.md`
- public: `docs/v2/cloudflare/runbook-public.md`
- target protocol: `docs/v2/publication-protocol.md`
- risks: `docs/v2/threat-model.md`

## Private: Cloudflare Access

Intended reach: an internet endpoint protected by Cloudflare Access.

Distinct authority gates typically include:

1. account preparation;
2. deploy credential creation;
3. Access identity policy and optional identity-provider configuration;
4. infrastructure plan/apply;
5. service-token creation for ingest;
6. packet upload (`--grant upload`);
7. alias promotion (`--grant promote`);
8. link sharing;
9. teardown and credential revocation.

Do not infer any later gate from an earlier one. Never run a prepared runbook merely because it exists.

Before returning a private URL, prove:

- unauthenticated requests are intercepted by Access;
- an allowed human identity reaches packet routes;
- a disallowed identity is refused;
- the ingest credential cannot be used as a reviewer session and vice versa;
- immutable and alias routes return the required cache behavior;
- receipts are read back and secret-scanned;
- the exact endpoint works from the reviewer's access surface.

Never capture browser HAR files, cookies, JWTs, API token values, or service-token secrets.

## Public: no Access

Public means anyone can read the packet endpoint. It is not merely “easier sharing.”

Requirements:

- packet classification must be `public`;
- use the structurally separate public target and state;
- use its dedicated deploy token and publisher signing key;
- keep private and public endpoints, credentials, ledgers, and infrastructure state separate;
- obtain explicit authority for the exact public packet, upload, alias promotion, and link sharing.

Warn before publication:

- immutable packet responses may be cached or copied indefinitely;
- deleting provider objects cannot recall third-party copies;
- moving/removing an alias does not invalidate a retained immutable content URL;
- the publisher has no automatic recall mechanism.

## Provider command boundary

The V2 CLI shape is:

```sh
node src/cli.mjs publish <packet-dir> \
  --target <target> --targets <targets.json> --grant upload

node src/cli.mjs promote \
  --target <target> --targets <targets.json> \
  --alias <alias> --content-id <content-id> \
  --expect-generation <n> --grant promote
```

Run only against a target whose infrastructure, credentials, endpoint, access mode, and cost ceiling have been independently verified. A target JSON file is not evidence that the deployment exists.
