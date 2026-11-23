# The red-control copy-set check

A red control runs its tests in a scratch copy. That copy holds only `src`, `test`, `fixtures`, `scripts` and `package.json`, plus the control's `extra`.

If a test reads something the copy lacks, the control's **baseline is red**, and its own "red" then proves nothing. That was H-QA-2, on e559653.

Rows tagged `H-*` (for example H-2, H-7.4, H-8.I1) are claims about the test harness itself: the copy set, test imports and the identifier scan. Their numbers are kept from earlier plans so that control history stays stable.

Two guards cover this:

1. **The static copy-set check.** It lives in `test/unit/red-controls-copy-set.test.mjs`. It is **lexical**: it sees exactly the forms listed below, and nothing else.
2. **The run-time harness verdict (the backstop).** Every control run starts with its baseline. A red baseline is reported by name: "`<id>: baseline is not green (exit N, first failure: …)`" (`runVerdict` in `scripts/red-controls.mjs`).

   This catches every case the static check misses, in any run that includes the control. QA showed that for each known limit below (79ca042, §3).

   So after any change, run every control whose `file` or `tests` changed. A miss by the static check then still surfaces as a named failure.

The three lists below are rendered by that test from its own `COPYSET_CLAIMS`, `COPYSET_LIMITS` and `COPYSET_UNEXERCISED`. The test fails if they differ from these, and it runs every claim and plants every limit. Case IDs are QA's (79ca042, §3).

## What the check sees (rendered from `COPYSET_CLAIMS`)

- (K1) A top-level directory is seen only when named as a path (`infra/…` or `./infra/…`), and a top-level file only by its exact name, in single, double or back quotes.
- (K2) Such a literal is a read only as the first argument of one of: `readFileSync(`, `readdirSync(`, `existsSync(`, `statSync(`; the test helpers `read(`, `disk(`, `at(`, `blocks(`; a read helper the file defines (K8); or `join(REPO, …)`.
- (K3) Test modules are followed through every relative `.mjs` import the import graph's lexer reads (static, side-effect, re-export, a plain-string dynamic import, require), in single or double quotes, that resolves under test/. An import named inside a string, comment, template or regex is not followed.
- (K4) There is no optional read: a path read only inside an `if (existsSync(X))` guard is still a dependency.
- (K5) The caught cases (CS1, CS2, CS9, CS8, CS4, CS5, CS11) are reported.
- (K6) Each known limit (CS3, CS6, CS7, CS10) is NOT reported, and is listed below as a known limit.
- (K8) A function the file defines on one line (`const f = (…) => …` or `function f(…) { … }`) whose body calls one of `readFileSync(`, `readdirSync(`, `existsSync(`, `statSync(` is a read call in that file, like the test helpers.
- (K9) A plain string constant (`const X = 'infra/…'`) passed as the first argument of a read call reads that path; a constant that is never passed to one is not a read.
- (K7) The backstop: a control whose copy lacks what its tests read has a red baseline, and the harness verdict names it ("baseline is not green"), in any run that includes the control.

## Known limits, exercised and not caught (rendered from `COPYSET_LIMITS`)

- (CS3) a path built from pieces (`'in' + 'fra/…'`)
- (CS6) `fs/promises` `readFile('infra/…')`
- (CS7) `new URL('../../infra/…', import.meta.url)`
- (CS10) `statSync(resolve(REPO, 'infra/…'))`

## Not seen and not exercised (rendered from `COPYSET_UNEXERCISED`)

- (U1) a read made by a module outside test/ (src/, scripts/), even one a test imports: imports are followed only under test/.