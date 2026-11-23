# Research records (verbatim)

These files are the maintainer's adapter research, read 2026-09-26 and cited throughout `docs/v2`, `infra` and `src/publication`. They were committed here byte-for-byte from the maintainer's research notes on 2026-09-28 (QA note N-PV-6), so every citation resolves inside this repository.

- **Verbatim, except for one recorded edit.** For the public release (2026-11-20), private role names in `cloudflare-adapter.md` were changed to "the maintainer" and the file was re-pinned. The version read on 2026-09-26 had SHA-256 `17eb620b1f810b462d630db74f05bf4d801c94a676c788ebd9b70d670e16522c`; no other byte changed. Each file's SHA-256 is pinned in `SHA256SUMS` and checked by `test/unit/v2-research-records.test.mjs`. Make no further edits: a correction belongs in the document that cites them.
- **Superseded where later decisions differ.** They are research, not decisions. The deploy token's scopes, in particular, are decided only by `infra/cloudflare/deploy-token-scopes.json` and its marked tables; what these records say about token permissions is historical input. That is why the scope-name gate skips these files, and only while their hashes match.
