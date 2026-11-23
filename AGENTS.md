# Canon project contract

## Authority

Authority is explicit and non-transitive. Permission to edit or commit locally does not grant permission to create a remote, push, open a PR, publish a packet externally, mutate cloud/DNS/identity infrastructure, deploy, or delete artifacts.

## What is authorized

Local work is authorized without a further go-ahead: building, testing, the local server on a loopback address, the filesystem publisher, and documentation, in a worktree on a feature branch. Deleting evidence or published artifacts is not local work.

Remote work is authorized one run at a time. Remote work is Cloudflare, VPS hosts, external publication, git remotes, push and PRs, provider plugin downloads, any server that listens on an address other than loopback, and any use of a real credential. Before each run, the maintainer MUST give a go-ahead that names the target account or host, the actions, the credential, and the cost ceiling. When the go-ahead states no cost ceiling, the ceiling is zero.

The go-ahead counts when either of these is true:

- The maintainer gave it to the agent that does the run.
- The brief quotes the maintainer's words exactly and says where and when the maintainer gave them. This is the only exception to non-transitive authority. The agent MAY confirm the quote with the maintainer before it acts. The agent MUST confirm with the maintainer before a step that the quoted words do not plainly cover.

A go-ahead covers only what it names. Each of these needs its own go-ahead, even inside an approved run: DNS records, custom domains, Cloudflare Access or other identity gates, public buckets, spending above the cost ceiling, and deleting cloud resources or published artifacts.

During a remote run:

- The agent MUST use only the credential that the go-ahead names.
- The agent MUST NOT print, log, or commit a secret or a signing key.
- The agent MUST publish only synthetic data, unless the go-ahead permits production data.
- Before the agent creates or changes a resource that the go-ahead does not name, it MUST stop and report.
- When the run ends, the agent MUST report every resource that exists, with its name, its id, and its teardown command.

Where another document in this repository sets a stricter rule for a run, such as confirmation at each step, the stricter rule applies. The phased plan in `docs/projects/review-packet-publisher.md` is the project's history. Where it and this section disagree, this section wins.

## Workflow

Use isolated Git worktrees for mutating work. Keep changes bounded and reviewable. Implementation, independent verification, and delivery reconciliation are separate roles. Verification failures are returned to implementation rather than fixed by the verifier.

Local commits on feature branches are authorized. Use focused commits and preserve tests/evidence with the code. Do not push or create a remote without separate maintainer authority.

## Evidence

Completion requires commands, exit status, and durable artifacts. Validate deterministic output, packet integrity, malicious inputs, responsive phone/iPad/laptop rendering, print/accessibility, asset fingerprinting, and zero external runtime requests. A local URL or worker claim alone is not completion.
