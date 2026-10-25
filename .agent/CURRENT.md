# Current task (reconciled 2026-10-25)

## Status
- Owner-requested project/deployment/payment-readiness review: COMPLETE; product baseline `5b45bd7`.
- Report: `docs/project-review-2026-10-25.md`; retained evidence: `docs/evidence/project-review-2026-10-25/`.
- Verdict: do not launch unrestricted paid production yet. Remediation and a controlled pilot are proposed, not approved implementation scope.
- Managed-service packages R1, R3, P1–P3, R2, R4 and R5 are merged. Tags: `phase-p1-complete`,
  `phase-p2-complete`, `phase-p3-complete`, `phase-r4-complete`, `phase-r5-complete`. Not deployed.
- Historical R5: 1812 tests passed/1 skipped, browser 30/30 on `0b9a1a2` (stand-in AI/captured mail).
- Fresh review: isolated lockfile install; Prisma generation, tsc, lint and 53 focused tests passed.
  Build environment-blocked (font network, then Turbopack port-bind EPERM); full DB/browser/provider suites not rerun.
- Fresh audit: full tree 1 high/5 moderate affected package entries; production dependencies 1 high/3 moderate.
- Manual Meta Business A visible reply is recorded on `905b4ca` (2026-10-25); Business B not retested.
  Provider smoke suites not run; previous waiver is not a pass. Gmail delivery passed historically, not production-domain token-flow acceptance.

## Next action
1. Await owner selection of the proposed remediation/pilot milestone in the review; no implementation task is currently selected.
2. Proposed first work: security patches, webhook redirect credentials, atomic reset, readiness/configuration/ingress,
   disposable-test DB/PID safeguards, key rotation/deadlines, AI-scoring gates and real managed-customer journey.
3. Before rollout: final candidate checks, actual deployment/proxy/sender/callback configuration, backup/restore,
   rollback, capacity/alerts and explicit pilot scope. Billing comes after those prerequisites.
4. Payment decisions: Ziyrak subscriptions versus customer payment collection, merchant company country, provider,
   pricing/allowances, cancellation/refund/grace policy. Review assumes subscriptions only for planning.

## Operational boundaries
- Main's installed Next/eslint-config-next are 16.4.0 (lock 16.4.3); Puppeteer is 24.43.1 (lock 25.15.0).
  Do not run dependency updates/builds in this possibly serving checkout; use isolated source/dependencies.
- Review scratch: `/private/tmp/ziyrak-review-20261025-8aZznQ`; no DB or services were created for this review.
- Prior owner cleanup is recorded in `5b45bd7`; do not assume archived worktrees/test databases still exist.
- The Business A test used a temporary Meta callback/tunnel. Confirm its current target before live acceptance.
- Never run the old loadtest script unchanged: unpaired DB URLs, name-based pkill, and stale-image reuse (review F08).

## Standing authorization retained (owner, 2026-10-23)
Within an approved milestone, merge only with exact-head CI green and the required combined-build browser run green,
then push main and recheck CI. This does not select the newly proposed remediation milestone or authorize rollout.
Still stop for tags, deploys, releases, force-push, deleting DBs/worktrees/branches, new milestone/phase,
real credential/mail actions, port 7700 and its live worker/remote-control topology.

## Worker start command (owner terminal; only after selecting the next milestone)
`cd ~/Development/Repos/JS/owly && CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 claude --model sonnet --settings '{"enabledPlugins":{"dart-flutter@dart-flutter":false}}'`
Then `/loop /ziyrak continue`; stop with `touch .agent/STOP`.
