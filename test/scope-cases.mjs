// Every document case QA has planted against the deploy-token scope gate (V2-QA-3, V2-QA-5,
// V2-QA-6, V2-QA-7), from QA's provider-validation attack set.
// test/unit/pv-deploy-token-scopes.test.mjs re-applies each one in memory, with every red
// control planted in a document, on every run: a case that was once caught can never
// pass silently again (V2-QA-7 (4)). Each appends `text` to `file` (a new file if absent).
// Not a test file itself.
export const QA_SCOPE_CASES = [
  // 985d5f2 (V2-QA-3)
  { id: 'P1-denial-yes/no-outside-block', file: 'docs/v2/cloudflare/coverage.md', text: 'Workers R2 Storage Edit: **no**. The maintainer creates the test bucket once in the dashboard.' },
  { id: 'A1-denial-does-not-include', file: 'docs/v2/cloudflare/coverage.md', text: 'The deploy token does not include Workers R2 Storage Edit.' },
  { id: 'A2-denial-omit', file: 'docs/v2/cloudflare/runbook.md', text: 'Omit Workers R2 Storage Edit from the token.' },
  { id: 'A3-denial-without', file: 'docs/v2/cloudflare/coverage.md', text: 'The token is created without R2 Storage permissions.' },
  { id: 'A5-denial-in-unscanned-doc', file: 'docs/v2/architecture.md', text: 'The deploy token is not granted Workers R2 Storage Edit (no).' },
  { id: 'A6-denial-in-threat-model', file: 'docs/v2/threat-model.md', text: 'Workers R2 Storage Edit: no.' },
  // 30279b8 (V2-QA-6 re-run, V2-QA-7)
  { id: 'P-I1-iac-comment', file: 'infra/cloudflare/terraform/main.tf', text: '# also granted: Zone DNS Edit, Workers Routes' },
  { id: 'S1-R2-edit-abbrev', file: 'docs/v2/cloudflare/coverage.md', text: 'The deploy token gets no R2 Edit permission.' },
  { id: 'S2-R2-write', file: 'docs/v2/cloudflare/runbook.md', text: 'Do not give the token R2 write access.' },
  { id: 'S4-D1-write-revoke', file: 'docs/v2/cloudflare/coverage.md', text: 'D1 write access is only for the migration and is revoked straight after.' },
  { id: 'S5-lowercase-name', file: 'docs/v2/cloudflare/coverage.md', text: 'workers r2 storage edit: not requested.' },
  { id: 'O1-README', file: 'README.md', text: 'Cloudflare deploy token: Workers R2 Storage Edit is not requested.' },
  { id: 'O2-operations-doc', file: 'docs/operations/review-service.md', text: 'Workers R2 Storage Edit: no.' },
  { id: 'O3-new-doc-dir', file: 'docs/cloudflare-notes.md', text: 'Workers R2 Storage Edit: no.' },
  { id: 'U-zone-dns-edit', file: 'infra/cloudflare/terraform/main.tf', text: '# also granted: Zone DNS Edit' },
  { id: 'U-zone-dot-dns-dot-edit', file: 'docs/v2/cloudflare/runbook.md', text: 'Grant Zone · DNS · Edit to the deploy token.' },
  { id: 'U-dns-edit', file: 'docs/v2/cloudflare/coverage.md', text: 'The deploy token also gets DNS Edit.' },
  { id: 'U-workers-kv-storage-edit', file: 'docs/v2/cloudflare/coverage.md', text: 'The deploy token also gets Workers KV Storage Edit.' },
  { id: 'U-zone-settings-edit', file: 'docs/v2/architecture.md', text: 'Add Zone Settings Edit to the token.' },
  { id: 'U-access-organizations', file: 'docs/v2/threat-model.md', text: 'Add Access: Organizations, Identity Providers, and Groups Edit.' },
  { id: 'U-cloudflare-tunnel-edit', file: 'docs/v2/cloudflare/runbook.md', text: 'Add Cloudflare Tunnel Edit to the deploy token.' },
  { id: 'U-workers-routes-no-verb', file: 'infra/cloudflare/terraform/main.tf', text: '# also granted: Workers Routes' },
  { id: 'U-zone-workers-routes-no-edit', file: 'docs/v2/cloudflare/coverage.md', text: 'The token has Zone · Workers Routes.' },
  // 346a111 (V2-QA-8, the optional all-scope credential entries)
  { id: 'G1-global-api-key', file: 'docs/v2/cloudflare/runbook.md', text: 'Use the Global API Key for the deploy step instead of a scoped token.' },
  { id: 'G3-super-administrator', file: 'docs/v2/cloudflare/runbook.md', text: 'Run apply as a Super Administrator.' },
];
// Not a scope-name case: "The maintainer creates the test bucket once in the dashboard before apply."
// (A4/S3) names no permission; a name gate cannot see it. Raised with the lead on the row.
