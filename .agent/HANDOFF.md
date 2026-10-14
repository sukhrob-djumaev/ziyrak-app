# Latest session handoff

Session: 2026-10-14 — managed-service product plan and reordered live roadmap.

## Changes and scope

- Owner approved adding the discussed business-workspace, admin and managed-AI
  product direction to the plan. This session changes documentation only.
- PLAN now owns one live board: finished foundations with evidence limits, then
  R1 → R3 → P1 → P2 → P3 → R2 → R4 → R5. R1 remains next; R3 isolation safeguards
  apply before all product work. P1–P3 are new tasks, not completed capabilities.
- Decision MS-2026-10-14 distinguishes platform super admin/assigned operators from
  business owners/admins/team, requires explicit audited support access, and adds
  channel scope, managed AI/allowances, verified accounts/recovery/invitations and
  resumable onboarding. Updated the older access/configuration/quota/MVP contracts
  and marked the relevant phase amendments so their old deferrals do not conflict.
- README describes the target separately from current setup; AGENTS/CURRENT point
  to the canonical live board. R5 remains the final naming pass, preserving history,
  attribution and necessary compatibility. No actual rename or product change yet.

## Evidence and decisions

Source inspection: signup provisions Business/User/owner Membership atomically;
AI keys/models are still customer configured; roles are business-wide and request
context selects the earliest membership. Platform-admin flag is not a console or
tenant bypass. Account email lifecycle and enforced AI allowances are missing;
best-effort usage logs cannot enforce a cap. These findings support extending the
existing architecture. “Small admins” are represented as separate Ziyrak operator
and customer workspace-admin roles. Production allowance/limit behavior and R2
quality thresholds still require concrete owner-reviewed proposals.

Product baseline: `c20513d78421816ac0096eff1cf3dbb0d6c9aa55`. Earlier assessment:
`1ea078cab50f66b7598869a3c40e14812ef93a49`; workflow rewrite:
`d7c106fc78faa10db80c0093618f60896eecd6d8`; R5 addition:
`54a6205a0f37a1b0ddc3058a9e82956187408584`. This revision is the commit containing
this handoff; inspect Git for its actual hash.

## Verification

Passed: formatting for README/AGENTS/CURRENT/HANDOFF, PLAN Markdown parsing,
whitespace checks, 40 local links/anchors, live task order and preservation of all
10 original phase tests-first/acceptance blocks, implementation history and assessment.
Independent read-only documentation/architecture review completed with no remaining
findings after reconciling old module/configuration wording and R4 dependencies.
This is not product security acceptance. No application tests/build/browser/provider
calls ran; application behavior, environments and milestone acceptance are unchanged.

## Continue

Start R1 via PLAN/CURRENT in an isolated worktree, following the shared protocol and
live-board dependencies. Prepare independent work if a real external blocker appears;
keep required acceptance open. Preserve protected port 7700/tunnel, live checkout,
database separation and existing Meta connections. No new product milestone,
enterprise completion tag, rollout, push or deployment is implied by this plan update.
