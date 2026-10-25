# Claude/Codex continuation preparation — 2026-10-25

Baseline `01a275d3fe5b7b8245722d81ea4f78d55d082ead`. The owner explicitly approved the launch preparation and asked
for reliable fresh-session continuation. This record concerns agent tooling and instructions, not L1 implementation.

## Contract and result

- Shared routing: AGENTS → PLAN + tracked CURRENT/HANDOFF → selected task; plain continue and Claude /ziyrak agree.
- Startup/status are read-only: no archival, dependencies, DB connections, runtime changes, fetch or background jobs.
- Resume a recorded registered worktree and matching branch before new work; honor STOP in relevant checkouts.
- Preserve one lead, exact acceptance, isolation, independent review, external boundaries and L7 authorization.
- CI success requires valid current structured evidence for the intended repository/commit and CI/build. Error,
  empty, malformed, skipped, neutral, stale identity or pending evidence cannot be success. CI remains separate
  from combined-build browser proof and permission to merge.

These requirements were checked against source and installed CLI help. No fresh model-backed Claude/Codex session
was launched: this is verified local tooling/routing, not a guarantee of future autonomous agent behavior.

## Regressions and independent review

The initial 10-test suite produced 11 failed assertions on the previous helpers, including false-green GitHub
errors, non-success status and head identity. Additional cases showed overall workflow success could hide a
skipped/missing build job; exact job checks were added. Independent security review identified repository selection,
active branch and coordinator-identity gaps; three new tests failed before those corrections. One test fixture
needed canonical /var versus /private/var path normalization; no product issue was inferred from it.

Final command: `python3 scripts/agent/test_workflow.py` — **22 tests passed**. Fixtures cover GitHub errors/malformed
JSON, empty/missing CI, failed/skipped/neutral/waiting states, wrong SHA, reruns, required build job, changed PR head,
wrong base/state, inconsistent CLI exit, wrong CWD/GH_REPO, missing context, STOP propagation, read-only hooks,
differently named worktrees, resume pointers, branch mismatch and coordinator protection on a feature branch.
All Git repositories/remotes/CLI results in these tests are synthetic temporary fixtures. No network, real CI,
app server, DB, container or provider is used. CI configuration now runs this suite; that remote run is not claimed.

Independent documentation review confirmed routing/scope and preserved the earlier model preference. Independent
script security review confirmed the fixes and reported no remaining blockers. These are AI-agent reviews, not a
human penetration test. Startup checks still do not enforce an OS-level single-writer lock; the guide requires one lead.

## Local checks and limits

- `bash -n scripts/agent/session-start.sh scripts/agent/ci-wait.sh scripts/agent/merge-gate.sh`: passed.
- Real-checkout preflight and hook: no tracked diff or status changes; CONTEXT_OK and WORKTREE_REQUIRED shown.
- CURRENT ≤60 lines; exact L1.1 acceptance text matches the roadmap; active checkout/branch intentionally `none`.
- Active Markdown relative targets/fragments and `git diff --check`: checked before commit.
- `.claude/settings.json`, local backups, client accounts/models/permissions and CLAUDE.md import unchanged.
- Application typecheck/lint/build, DB/Redis/browser/provider tests and actual remote CI: **not run** for this tooling task.
- No product code/dependency/build changes, push, deploy, live charge, real process shutdown or user DB operations.

See [start guide](../guides/agent-continuation.md) and [L1.1 task packet](../tasks/l1.1-safe-verification-harness.md).
The containing local commit is the implementation identity; future model execution must verify its own candidate.
