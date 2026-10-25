# Launch rebaseline verification — 2026-10-25

## Scope and identity

- Reviewed source/documentation baseline: `3066b33`; preceding product baseline: `5b45bd7`.
- Rebaseline changes current Markdown guidance, wiki routing/archive and `.env.example`; no product implementation,
  dependencies, private environment files, database, service, external account, deployment or payment changed.
- L0 is documentation/requirements completion only. L1–L7 runtime criteria are not passed by this work.
- The containing Git commit identifies these docs; do not invent a future commit hash.

## Review and source checks

Two independent read-only AI-agent investigations covered documentation drift and dashboard/access/launch requirements.
The dashboard reviewer additionally reviewed the billing/launch contracts; the documentation reviewer checked final
entry points, historical preservation and continuation consistency. These are independent agent passes, not human
security assessment or measured user research.

Integrated corrections: sandbox B01–B11 vs B12 live-money boundary; fail-closed approval policy on entitlement loss;
per-capability grant composition/expiry and version retirement; ownership of MFA/signup-abuse/global-spend work;
source pointers; tenant/ownership/return-URL checks for billing sessions; truthful account-mail dependency; conditional
SMTP configuration; useful current approval guidance; safe harness/real-UI acceptance gaps. The served OpenAPI
metadata/schema remains product-side follow-up D11/L3, explicitly labelled in its documentation entry point.

Commands/configuration were cross-checked against package.json, CI, prisma.config.ts, worker startup, mail transport,
RBAC, signup/onboarding, sidebar/header, channel connection handling and the acceptance runner. No full application
suite was necessary for the documentation-only change; none was rerun. Future operating instructions still require
L2/L6 rehearsal. Provider design research links are in the billing contract; no provider is selected.

## Mechanical checks

- Relative Markdown targets and fragments in modified/new active docs: checked; old wiki archive excluded from
  current-guidance link validity because original extensionless wiki links are preserved unchanged.
- Two previously broken PLAN history anchors were corrected to existing section headings.
- All 35 wiki originals were compared byte-for-byte with `git show HEAD:docs/wiki/<name>` and match the archive.
- Original numbered architecture body from `## 0. Summary of Second-Pass Revisions` onward was compared byte-for-byte
  with HEAD and is unchanged. Its introductory amendment pointer is the only edit.
- CURRENT is 40 lines; roadmap, README, PLAN and state consistently select L1.1 next.
- `git diff --check`: passed. Staged status/diff reviewed before the local commit.

Check counts are recorded in the adjacent [JSON result](launch-rebaseline-2026-10-25-checks.json).
Historical review results remain in [the project audit](../project-review-2026-10-25.md); no old test run was relabelled
as current acceptance. No push, deploy or live-money action was performed.
