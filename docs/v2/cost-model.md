# Publisher V2: cost model

**Sources.** Prices are the list prices recorded in the research, all read 2026-09-26. None was re-fetched in this phase.

- `docs/v2/research/cloudflare-adapter.md` §3.9. Its sources are [S1] (R2 pricing) and [S6] (Workers pricing).

**Status.** No provider was contacted and nothing was billed. Every figure here is an estimate; real billing is provider evidence (V2-10), NOT_EXECUTED.

## 1. Unit prices used by the ledger

`UNIT_PRICES` in `src/publication/policy.mjs`:

| Kind | Object write | Object read | Storage (per GB-month) | Alias move | Source |
| --- | --- | --- | --- | --- | --- |
| `mock-cloudflare` / `cloudflare` | $4.50 per 1M (R2 Class A) | $0.36 per 1M (R2 Class B) | $0.015 | $0 (a D1 row write, within the included allowance) | CF §3.9 [S1][S6] |
| `fs` | $0 | $0 | $0 | $0 | local |

**How the estimates are built:**

- **Free tiers are ignored,** so every estimate is an upper bound (deviation 11). For example, Cloudflare's R2 free tier is 10 GB, 1M Class A and 10M Class B a month.
- **Storage is charged in the month of upload.** A packet is costed at one GB-month of its bytes when it is written.
- **Serving costs are not metered by the publisher.** These are Worker requests. They come from reviewers, not from publish operations, and the research puts them at $0 within free tiers at both the stated scale and 10×.

## 2. Workload estimates (from the research)

| | Cloudflare (CF §3.9) |
| --- | --- |
| Stated scale | 30 packets a month of about 3 MB: **$0 a month** |
| 10× scale | **≈ $0 to $0.20 a month** (R2 storage above 10 GB in year 2) |
| Dominant line | none within free tiers |
| Fixed extras (not priced) | Workers Paid at $5 a month, only if ingest CPU grows; the Access seat price is unverified |

**Worked estimate for one operation** (what a receipt records): on Cloudflare, publishing a 20-file, 5 MB packet is ≈ $0.0002, and a promote is ≈ $0.

## 3. Ceiling and ledger rules

These are enforced in `src/publication/policy.mjs` and `protocol.mjs`, and held by V2-10 and R81.

1. **Every target has a ceiling.** `costCeilingUsdPerMonth` is required by `publication-targets/v1` for every target. There is no default and no "unlimited".
2. **Refusal happens before the first provider request.**
   - Before `publish`, the publisher computes the projected cost of the whole packet: writes, read-back reads and storage.
   - Before `promote` or `rollback`, it computes one alias move plus four reads.
   - If month-to-date plus the projection would **exceed** the ceiling, the operation fails `cost-ceiling`, and no provider request is made (R81; R98 for promote).
3. **The ledger is a local, append-only JSONL file per target.**
   - It lives at `<ledgerDir or stateDir or root>/ledger/<target>.jsonl`.
   - Each line holds `{at, receiptId, operation, requestCount, bytesUploaded, estimatedCostUsd}`, copied from a written receipt.
   - Month-to-date is the sum of lines whose `at` falls in the current UTC month.
4. **Actual cost is recorded, not projected cost.**
   - A receipt's `estimatedCostUsd` uses the writes that actually happened (`created`, not `identical`) and the requests actually made.
   - A resumed publish therefore costs only its new writes.
   - Failed and refused operations that reached the target are recorded too, from their result receipt (R97).
5. **The ledger is never edited to make room.** It holds no secrets: the receipt it copies has already passed the secret scan.

**Recommended ceiling for provider validation:**

- **Cloudflare:** $5 a month (CF §3.9 "budget ceiling").

The value belongs to the maintainer (see [architecture.md](architecture.md) §6).

## 4. Known gaps

- **The ledger is local,** so two machines publishing to one target each see only their own spend. Provider billing alerts remain the backstop, and they are separately authorized provider configuration.
