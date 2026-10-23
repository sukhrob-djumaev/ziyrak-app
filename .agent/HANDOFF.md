# Latest session handoff (2026-10-23)

- R2 (rule-based escalation) MERGED to main: PR #31, merge `6225d00`, head `dbe5b4c`. CI green on the exact head and on main `6225d00`.
- Browser verification on the combined build (stand-in AI, captured mail, fresh DBs, system Chrome, Redis 6381): full suite 28/28 on head
  `dbe5b4c` (incl. J11 handoff, J03/J03b isolation); again J01-J28 pass on a fresh build of main `6225d00`. First J12 run failed on a
  harness assumption (R2's no_support rule escalates J12's own probe conversation); fixed by choosing the target conversation first (`dbe5b4c`).
- New journey `j29-operator-invitations` (PR #32, `test/j29-operator-invitations`): real-UI invite, captured mail, accept without session,
  audits, single-use link, sign-in, 409 on existing address. Passed on main's build after fixing its probe (operators get 409 workspace
  selection on /api/me; use /api/platform/enrollment). Not yet in main until PR #32 merges and CI is green.
- Not done: real mail check (needs PLATFORM_SMTP_* + mailbox), fresh unbiased R2 evaluation set, P3 tag (blocked on real mail).
- Resources left running/kept: DBs `ziyrak_acceptance_r2_20261023{a,b,c}`, Redis container `ziyrak-acc-redis-r2_20261023a`, acceptance topology
  from worktree `../owly-wt-r2` (stop with `runtime.cjs stop all`), worktrees `../owly-wt-r2`, `../owly-wt-operator-invitations`.
- Continue: merge PR #32 when exact-head CI is green; then next eligible work needs owner input (R4 final acceptance is blocked on real mail
  and the R1 provider boundary).
