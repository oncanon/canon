# `report/v1` Schema Reference (Single-Page Brief)

Use `report/v1` (`canon brief <report.json> --alias <name>`) for single-page architecture proposals, design reviews, PR/diff walkthroughs, verification proofs, incident postmortems, and structured trade-off decisions.

The schema is **closed**: unknown keys and markup/style escape hatches (`html`, `style`, `class`, `script`, `svg`, etc.) fail validation immediately. All strings must be NFC-normalized UTF-8 without control characters or line breaks (except `code.source` and `diff.patch`).

## Minimal Valid Skeleton

Save this JSON next to `evidence/check.txt` and build/publish with `canon brief <file.report.json> --alias <project>-<topic>`:

<!-- minimal-report-v1 -->
```json
{
  "schema": "report/v1",
  "id": "example-design-review",
  "title": "Queue Worker Retry Policy Review",
  "subtitle": "Bounded exponential backoff and dead-letter routing",
  "metadata": {
    "status": "proposed",
    "classification": "Internal engineering review",
    "reviewDate": "2026-11-13",
    "authors": ["Agent"],
    "reviewRequest": "Confirm backoff ceiling and dead-letter retention window."
  },
  "summary": {
    "verdict": {
      "confidence": "recommended",
      "text": "Adopt bounded jittered backoff capped at 60s with a 14-day dead-letter queue."
    },
    "paragraphs": [
      "Unbounded retries amplified transient downstream timeouts during load testing."
    ],
    "metrics": {
      "items": [
        { "label": "Retry storm peak", "value": "3.4", "unit": "x", "evidence": ["ev-check"] }
      ]
    }
  },
  "evidence": [
    {
      "id": "ev-check",
      "title": "Verification check output",
      "kind": "file",
      "path": "evidence/check.txt",
      "mediaType": "text/plain"
    }
  ],
  "sections": [
    {
      "id": "sec-findings",
      "title": "Findings and Decisions",
      "lede": "Key empirical findings and open operator decisions.",
      "blocks": [
        {
          "type": "finding",
          "id": "find-backoff",
          "title": "Unbounded retries saturate worker pool",
          "severity": "high",
          "confidence": "proven",
          "claim": [
            "Workers retried immediately on HTTP 503, exhausting concurrency within 12s ",
            { "cite": "ev-check" },
            "."
          ],
          "evidence": ["ev-check"]
        },
        {
          "type": "decision",
          "id": "dec-dlq-window",
          "question": "Which dead-letter retention window should we enforce?",
          "status": "needed",
          "owner": "Maintainer",
          "recommendation": "Use 14 days to cover holiday/weekend incident triage without unbounded storage growth.",
          "alternatives": [
            { "label": "14 days", "summary": "Covers multi-day outages with bounded disk usage." },
            { "label": "30 days", "summary": "Higher storage footprint with minimal extra recovery value." }
          ]
        }
      ]
    }
  ],
  "provenance": {
    "sources": [
      {
        "label": "Workspace test run",
        "reference": "npm test"
      }
    ],
    "notes": "Generated from local verification artifacts."
  }
}
```

## Identifier Rules

- **Top-level `id`:** `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase ASCII alphanumeric + hyphens, max 64 chars).
- **Section, Evidence, and Block `id`s:** `^[A-Za-z][A-Za-z0-9-]{0,63}$` (must start with an ASCII letter, max 64 chars). Every `id` across sections, appendices, blocks, and evidence items must be **globally unique ignoring ASCII case**.

## Top-Level Fields

| Field | Required | Shape / Constraints |
| --- | --- | --- |
| `schema` | Yes | `"report/v1"` |
| `id` | Yes | Slug matching `^[a-z0-9][a-z0-9-]{0,63}$` |
| `title` | Yes | String (`1..160` chars) |
| `subtitle` | No | String (`1..300` chars) |
| `metadata` | Yes | `{ status: "draft" \| "proposed" \| "final", classification: string, reviewDate: "YYYY-MM-DD", authors: string[1..12], reviewRequest: string }` |
| `summary` | Yes | `{ verdict: { confidence: "proven" \| "recommended" \| "defect" \| "open", text: Inline }, paragraphs: Inline[1..12], metrics?: { items: MetricItem[1..12] } }` |
| `evidence` | Yes | Array (`min: 1`) of evidence records (paths resolved relative to the directory containing `<report.json>`) |
| `sections` | Yes | Array (`min: 1`) of `{ id, title, lede?, blocks: Block[1..200] }` |
| `appendices` | No | Array (`min: 1`) of `{ id, title, lede?, blocks: Block[1..200] }` |
| `provenance` | Yes | `{ sources: [{ label, reference, sha256?, revision? }][1..32], notes?: Inline }` (`sha256` = 64 lowercase hex; `revision` = 7..64 lowercase hex) |
| `publication` | No | `{ classification?: "public" \| "private-review" \| "confidential", dataOrigin?: "synthetic" \| "production" }` |

## Inline Text Grammar (`Inline`)

Anywhere `Inline` is accepted, supply either a plain single-line string (`"Plain text"`) or a non-empty array of strings and single-key span objects:

- `"plain text"` or `{ "text": "plain text" }`
- `{ "code": "inline_identifier()" }`
- `{ "em": "emphasized" }`
- `{ "strong": "bold" }`
- `{ "cite": "ev-check" }` (must match a declared `evidence[].id`)
- `{ "link": { "href": "https://example.com/path", "text": "Normalized HTTPS URL only" } }` (`https:` only, normalized `URL.href`)

## Evidence Records (`evidence[]`)

At least **one** evidence item is required in every report:

1. **Bundled file (`kind: "file"`):**
   ```json
   {
     "id": "ev-log",
     "title": "Test runner output",
     "kind": "file",
     "path": "evidence/test-output.txt",
     "mediaType": "text/plain"
   }
   ```
   - `path` is relative to the `<report.json>` directory (POSIX segments, no `..`, no leading `/`).
   - `mediaType` **must** be one of `"text/plain"`, `"text/csv"`, or `"application/json"`.
2. **Redacted or unavailable (`kind: "redacted"` or `"unavailable"`):**
   ```json
   {
     "id": "ev-prod-trace",
     "title": "Customer trace payload",
     "kind": "redacted",
     "reason": "Contains customer PII; summarized in metrics."
   }
   ```

## Block Types (`sections[].blocks[]`)

- **`paragraph`**: `{ "type": "paragraph", "text": Inline }`
- **`list`**: `{ "type": "list", "ordered"?: boolean, "items": Inline[] }`
- **`metrics`**: `{ "type": "metrics", "items": [{ "label": string, "value": string, "unit"?: string, "evidence"?: string[] }] }`
- **`finding`**:
  ```json
  {
    "type": "finding",
    "id": "find-1",
    "title": "Short active-voice title",
    "severity": "critical | high | medium | low | info",
    "confidence": "proven | recommended | defect | open",
    "verification": { "band": "code | judgment | review | needs-review", "detail": "Optional gate/rubric note" },
    "claim": "Concise claim (uppercase MUST/MUST NOT highlighted per RFC 2119)",
    "evidence": ["ev-check"],
    "detail": [{ "type": "paragraph", "text": "Optional; only paragraph, list, or code blocks allowed inside detail." }]
  }
  ```
  - `verification` (optional, `HR-004`): `{ band: "code" | "judgment" | "review" | "needs-review", detail?: string }` (`"code"` = machine-gated, `"judgment"` = semantic rubric, `"review"` = human sign-off, `"needs-review"` = unclassified).
- **`decision`** (MADR-aligned):
  ```json
  {
    "type": "decision",
    "id": "dec-1",
    "question": "Question requiring alignment?",
    "status": "needed | decided",
    "owner": "Optional owner",
    "context": "Optional problem forces & constraints motivating the decision",
    "recommendation": "Inline recommendation",
    "alternatives": [
      { "label": "Option A", "summary": "Inline summary", "chosen": true, "recommended": true },
      { "label": "Option B", "summary": "Inline summary" }
    ],
    "consequences": ["Positive or negative architectural consequence 1", "Consequence 2"]
  }
  ```
  - **Consistency rule:** When `status` is `"needed"`, **zero** alternatives may set `"chosen": true`. When `status` is `"decided"`, **exactly one** alternative must set `"chosen": true`.
  - **`recommended`** (optional): `true` on **at most one** alternative marks the option the recommendation names (render-policy/2 shows it with `→`). Omit it rather than writing `false`; `false` is rejected. render-policy/1 and `report.md` ignore it.
- **`requirement`** (EARS + Gherkin specification, `HR-000` / `HR-004`):
  ```json
  {
    "type": "requirement",
    "id": "req-1",
    "title": "Zero-allocation ingest ring slot",
    "pattern": "ubiquitous | event | state | unwanted | optional",
    "verification": { "band": "code", "detail": "bench-zero-alloc gate" },
    "statement": "WHEN an ingest worker receives a valid telemetry frame, the ring writer MUST commit the slot without heap allocation.",
    "scenarios": [
      {
        "name": "Steady-state frame commit",
        "given": "an initialized 64 MiB arena ring with free slots",
        "when": "a 4 KiB frame arrives over gRPC",
        "then": "heap_alloc_bytes delta equals 0 and write_head advances by 1"
      }
    ],
    "evidence": ["ev-check"]
  }
  ```
- **`comparison`** (side-by-side concept, architecture, or code contrast):
  ```json
  {
    "type": "comparison",
    "id": "cmp-1",
    "title": "Per-Frame Heap Decode vs. Arena Ring Slot",
    "caption": "Optional caption with inline citations",
    "left": {
      "label": "v2 Legacy: Heap Decode",
      "tone": "legacy | neutral | proposed",
      "summary": "Allocates 3 buffers per frame under mutex contention.",
      "items": ["24 allocs/batch", "GC pause spikes at p99"],
      "code": { "language": "typescript", "source": "const msg = JSON.parse(buf.toString());" }
    },
    "right": {
      "label": "v3 Proposed: Zero-Copy Slot",
      "tone": "proposed",
      "summary": "Reads fixed header directly from mmap slab via CAS.",
      "items": ["0 heap allocs/frame", "Deterministic replay offset"],
      "code": { "language": "typescript", "source": "const slot = ring.claimNextSlot(len);" }
    },
    "evidence": ["ev-check"]
  }
  ```
- **`risk`**: `{ "type": "risk", "id": "risk-1", "title": string, "likelihood": "low|medium|high", "impact": "low|medium|high", "mitigation": Inline }` (consecutive `risk` blocks automatically render in a dense 2-up risk matrix).
- **`code`**: `{ "type": "code", "id": "code-1", "title": string, "language": "typescript|javascript|json|shell|yaml|text", "source": "multiline\ncode", "highlight"?: [[1, 2]], "caption"?: Inline }` (note: use `"text"` or `"typescript"`/`"javascript"` if a language is not in the 6-value enum).
- **`diff`**: `{ "type": "diff", "id": "diff-1", "title": string, "language": "typescript|javascript|json|shell|yaml|text", "patch": "--- a/x\n+++ b/x\n...", "caption"?: Inline }`
- **`table`**:
  ```json
  {
    "type": "table",
    "id": "tbl-1",
    "caption": "Plain string caption (max 300 chars)",
    "columns": [
      { "key": "metric", "label": "Metric" },
      { "key": "p99", "label": "p99 (ms)", "numeric": true }
    ],
    "rows": [
      { "metric": "Read latency", "p99": "14.2" }
    ]
  }
  ```
  - Every row object must have the exact set of column `key`s (`^[A-Za-z][A-Za-z0-9-]{0,63}$`).
- **`chart`** (pure deterministic SVG + accessible tabular ledger):
  1. **Single-series horizontal bar (`kind: "bar"`):**
     `{ "type": "chart", "id": "ch-1", "title": string, "kind": "bar", "unit": "ms", "series": [{ "label": "Stage A", "value": 42 }], "caption": Inline, "evidence"?: ["ev-check"] }`
  2. **Grouped baseline vs. candidate comparison (`kind: "comparison"`):**
     ```json
     {
       "type": "chart",
       "id": "ch-cmp",
       "title": "Ingest Latency Before vs. After Arena Ring",
       "kind": "comparison",
       "unit": "ms",
       "baselineLabel": "v2 Heap Queue",
       "candidateLabel": "v3 Arena Ring",
       "higherIsBetter": false,
       "series": [
         { "label": "Batch commit p50", "baseline": 4.8, "value": 0.35 },
         { "label": "Batch commit p99", "baseline": 38.4, "value": 2.1 }
       ],
       "caption": "Auto-computes speedup / % delta pills.",
       "evidence": ["ev-check"]
     }
     ```
  3. **Latency quantiles whisker plot (`kind: "quantiles"`):**
     ```json
     {
       "type": "chart",
       "id": "ch-q",
       "title": "Tail Latency Distribution Across Load Profiles",
       "kind": "quantiles",
       "unit": "ms",
       "budget": 5.0,
       "series": [
         { "label": "100k msg/s steady", "p50": 0.32, "p95": 0.94, "p99": 1.85, "max": 2.4 },
         { "label": "250k msg/s burst", "p50": 0.48, "p95": 1.62, "p99": 3.40, "max": 4.6 }
       ],
       "caption": "Requires p50 <= p95 <= p99 (and <= max when provided).",
       "evidence": ["ev-check"]
     }
     ```
- **`diagram`** (pure deterministic SVG + accessible structural ledger):
  1. **Pipeline flow (`kind: "flow"`):**
     `{ "type": "diagram", "id": "dg-flow", "title": string, "kind": "flow", "steps": [{ "label": "Build", "detail": "Validate report/v1" }, { "label": "Verify", "detail": "Hash check", "gate": true }], "caption": Inline, "evidence"?: ["ev-check"] }` (`2..16` steps).
  2. **Layered system topology (`kind: "topology"`):**
     ```json
     {
       "type": "diagram",
       "id": "dg-topo",
       "title": "Ingest & Deterministic Replay Topology",
       "kind": "topology",
       "groups": [
         {
           "id": "grp-edge",
           "label": "Ingress Tier",
           "nodes": [
             { "id": "n-grpc", "label": "gRPC Framing", "sublabel": "TLS + CRC32C", "role": "entry" }
           ]
         },
         {
           "id": "grp-core",
           "label": "Zero-Copy Core",
           "nodes": [
             { "id": "n-cas", "label": "CAS Slot Gate", "sublabel": "Seq lock", "role": "gate" },
             { "id": "n-wal", "label": "Segmented WAL", "sublabel": "mmap 64 MiB", "role": "store" }
           ]
         }
       ],
       "edges": [
         { "from": "n-grpc", "to": "n-cas", "label": "frame slice", "style": "solid" },
         { "from": "n-cas", "to": "n-wal", "label": "commit offset", "style": "gate" }
       ],
       "caption": "Roles: entry | core | store | gate | external. Edge styles: solid | dashed | gate.",
       "evidence": ["ev-check"]
     }
     ```
  3. **Actor interaction sequence (`kind: "sequence"`):**
     ```json
     {
       "type": "diagram",
       "id": "dg-seq",
       "title": "Lock-Free Ring Slot Reservation & Consumer Replay",
       "kind": "sequence",
       "actors": [
         { "id": "a-prod", "label": "Ingest Worker", "kind": "service" },
         { "id": "a-ring", "label": "Arena Ring", "kind": "store" },
         { "id": "a-cons", "label": "Replay Verifier", "kind": "verifier" }
       ],
       "messages": [
         { "from": "a-prod", "to": "a-ring", "label": "fetch_add(write_head)", "kind": "sync" },
         { "from": "a-ring", "to": "a-ring", "label": "store release(seq_committed)", "kind": "self", "gate": true, "note": "Publish barrier" },
         { "from": "a-cons", "to": "a-ring", "label": "load acquire(seq_committed)", "kind": "reply" }
       ],
       "caption": "Actor kinds: actor | service | store | verifier. Message kinds: sync | async | reply | self.",
       "evidence": ["ev-check"]
     }
     ```
