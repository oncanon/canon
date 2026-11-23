# `site-input/v1` Schema Reference (Multi-Page SitRep Bundle)

Use `site-input/v1` (`canon sitrep <site-input.json> --alias <name>`) when publishing a multi-area operational situation report (SitRep), cross-project portfolio status, or multi-page review with a left navigation rail, area rollups, unassigned items page, and structured decision queue.

For a single-topic technical brief, architecture proposal, or verification walkthrough, prefer `report/v1` (`canon brief`) instead.

## Minimal Valid Skeleton

Save this JSON next to `evidence/check.txt` and build/publish with `canon sitrep <file.site-input.json> --alias <project>-sitrep`:

<!-- minimal-site-input-v1 -->
```json
{
  "schema": "site-input/v1",
  "title": "Weekly Engineering SitRep",
  "edition": {
    "editionId": "ed-2026-11-13T1500Z",
    "editionDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "observedAt": "2026-11-13T15:00:00Z",
    "coverage": {
      "from": "2026-11-06T15:00:00Z",
      "to": "2026-11-13T15:00:00Z"
    }
  },
  "registry": {
    "version": "v1",
    "sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
  },
  "gaps": [
    {
      "gapRef": "gap-unmapped-intake",
      "kind": "unmapped-source",
      "text": "Triage inbox items have not yet been assigned to an engineering area."
    }
  ],
  "evidence": [
    {
      "id": "ev-check",
      "title": "Build gate summary",
      "kind": "file",
      "path": "evidence/check.txt",
      "mediaType": "text/plain"
    }
  ],
  "areas": [
    {
      "areaRef": "platform",
      "title": "Platform Infrastructure",
      "counts": {
        "waiting": 1,
        "moved": 4,
        "blocked": 0,
        "coverage": "complete",
        "gapRefs": [],
        "unit": "items"
      },
      "projects": [
        {
          "projectRef": "publisher",
          "title": "Review Publisher"
        }
      ]
    }
  ],
  "items": [
    {
      "itemRef": "item-tailnet-rollout",
      "areaRef": "platform",
      "projectRef": "publisher",
      "title": "Tailscale preview serving rollout",
      "age": "2d",
      "blocks": [
        {
          "type": "paragraph",
          "text": [
            "Local verification passed cleanly ",
            { "cite": "ev-check" },
            "."
          ]
        }
      ]
    }
  ],
  "decisions": [
    {
      "decisionRef": "dec-rollout-mode",
      "label": "Confirm default workstation exposure mode",
      "kind": "exposure-policy",
      "itemRef": "item-tailnet-rollout",
      "questions": [
        {
          "questionRef": "q-default-mode",
          "text": "Should workstation previews stay on Tailscale by default?",
          "options": [
            {
              "optionRef": "opt-tailscale",
              "label": "Tailscale default",
              "summary": "Reachable across personal tailnet devices."
            },
            {
              "optionRef": "opt-local",
              "label": "Loopback default",
              "summary": "Reachable only on 127.0.0.1."
            }
          ],
          "recommendation": {
            "text": "Keep Tailscale active for seamless iPad and phone review.",
            "optionRef": "opt-tailscale"
          },
          "freeText": {
            "allowed": true,
            "maxChars": 500
          },
          "evidence": ["ev-check"]
        }
      ]
    }
  ]
}
```

## Key Constraints & Consistency Rules

1. **Closed Schema & Shared Block Grammar:**
   - Top-level required keys: `schema` (`"site-input/v1"`), `title`, `edition`, `registry`, `areas`, `items`, `decisions`, `evidence`, `gaps`. Optional: `history`, `publication`.
   - `publication` (optional): `{ classification?: "public" \| "private-review" \| "confidential", dataOrigin?: "synthetic" \| "production" }`, the same extension `report/v1` takes. Absent means `private-review` and `production`. Present, it is copied onto the built bundle's `manifest.site.publication` and becomes part of the bundle's content id; a provider publish target accepts the bundle only when it declares `dataOrigin: "synthetic"` (or the target explicitly sets `allowProductionData: true`).
   - `items[].blocks` uses the exact same Canon v2 block vocabulary and `Inline` grammar as `report/v1` (`paragraph`, `list`, `finding` with optional `HR-004` `verification`, `requirement` with EARS `pattern` + `verification` + Gherkin `scenarios`, `comparison` legacy-vs-proposed side-by-side blocks, `risk` auto-paired into 2×2 `.risk-grid`, `code`, `diff`, `table`, `chart` with `bar` / `comparison` / `quantiles`, `diagram` with `flow` / `topology` / `sequence`, and `metrics`), **except** `decision` blocks are forbidden inside `items[].blocks` — declare decisions in top-level `/decisions` referencing `itemRef`.
   - Bundled `.csv`, `.json`, and `.txt` evidence files automatically render bounded inline previews on their owning page alongside cross-page `Cited by` back-reference links.
   - `items[].age` values beginning with `blocked`/`stalled`/`overdue`, `waiting`/`pending`/`queued`, or `moved`/`shipped`/`done`/`resolved`/`merged`/`closed` automatically receive semantic status pills across portfolio, area, project, and item views.
2. **Timestamps & Hashes:**
   - `observedAt`, `coverage.from`, `coverage.to`, and `history[].observedAt` must be exact UTC ISO-8601 strings matching `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds), with `from <= to`.
   - `editionDigest` and `registry.sha256` must be 64-character lowercase hex SHA-256 digests.
3. **Reference Namespaces (`Refs`):**
   - `gapRef`, `areaRef`, `projectRef` (scoped per area), `itemRef`, `decisionRef`, `questionRef`, and `optionRef` (scoped per question) must match `^[A-Za-z][A-Za-z0-9-]{0,63}$` and are case-insensitively unique within their namespace, resolved by exact case match.
   - `"unassigned"` is reserved and cannot be used as an `areaRef`.
   - `decision.kind` and `gap.kind` must match `^[a-z][a-z0-9-]{0,39}$`.
4. **Counts & Gap Honesty (`areas[].counts`):**
   - `waiting`, `moved`, `blocked`: each is a non-negative safe integer or `null` ("not recorded").
   - `coverage: "complete"` requires all 3 counts to be integers.
   - `coverage: "unavailable"` requires all 3 counts to be `null` and `gapRefs` non-empty.
   - `coverage: "partial"` requires 1 or 2 counts recorded and `gapRefs` non-empty.
5. **Unassigned Items (`areaRef: null`):**
   - If an item has `"areaRef": null`, `"projectRef"` must also be `null` and `"gapRefs"` must contain at least one declared `gapRef` explaining why.
6. **Questions (`decisions[].questions[]`):**
   - `freeText`: `{ "allowed": true, "maxChars": 1..4000 }` or `{ "allowed": false }` (do not include `maxChars` when `allowed: false`).
   - If `freeText.allowed` is `false`, `options` must contain at least 2 options.
7. **Bundle Output Routes:**
   - Human entry: `/a/<alias>/` (redirects via `307` to `/p/<content-id>/index.html`, with drill-down pages under `/p/<content-id>/` at `area/<areaRef>/index.html`, `area/<areaRef>/project/<projectRef>/index.html`, `area/unassigned/index.html` when unassigned items exist, and `item/<itemRef>/index.html`).
   - Agent Markdown entry: `/a/<alias>/index.md` (redirects via `307` to `/p/<content-id>/index.md`, with matching `.md` siblings at every sub-route under `/p/<content-id>/`).
