# Handoff - latest session (2026-10-28)

- Merged L4.1b (PR #55, `081c35c`) after a design review and a security review whose findings were fixed. Evidence: `docs/evidence/l4.1b-entitlements-2026-10-28.md`.
- Verified on `d70e631`: CI green; browser 34/34. Earlier runs were lost to machine overload (VM/simulator/contactsd) and to a monitor timeout killing a non-detached run; run `run-all.sh` with nohup and watch the log read-only.
- Cleanup done at the owner's request: merged worktrees and branches, 24 acceptance databases, Docker images/cache/volumes (~60 GB). Kept: ziyrak-l11-pg, ziyrak-l12-redis, owly-db-1 and its volumes, worktree owly-l4-2 (L4.1b, merged: remove before/after the next worktree). Old scratch dirs /private/tmp/ziyrak-l*-acc* remain until `rm -rf` is allowed.
- Continuation: L4.1c, then L4.2 (owner commercial decisions). Owner inputs still open: backup RPO/RTO, alert routing, incident owners, offboarding, OpenAI key for L1.4 evaluation, task sessions with intended users, bulk-export-after-downgrade decision.
