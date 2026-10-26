# Handoff - latest session (2026-10-26)

- Merged L2.2 (PR #51, `c19c4fe`) after an independent security review: fixed leftover DB volumes, argv secrets, weak publish gate, scanner socket, digest deploy, migration guard gaps. Evidence in `docs/evidence/l2.2-release-operations-2026-10-26.md`.
- Verified on `f67d70c`: CI build+image green; browser 30/30 (precondition: migrate a fresh acceptance DB before `start-all.sh`); image smoke OK; Trivy 0; restore drill 60 tables 0 mismatches.
- Continuation: start L3.1 in a new worktree. Open owner inputs listed in CURRENT. Leftovers needing owner OK to delete: worktrees owly-l1-*, owly-l2-1, owly-l2-2; docker ziyrak-l11-pg / ziyrak-l12-redis; ziyrak_acceptance_* DBs; 15 dangling Docker volumes from earlier drills.
