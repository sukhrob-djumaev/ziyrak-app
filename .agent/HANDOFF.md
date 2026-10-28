# Handoff - latest session (2026-10-28)

- Merged L4.1a (PR #54, `a977869`) after a design review and a security review whose findings were fixed. Evidence: `docs/evidence/l4.1a-catalog-2026-10-28.md`.
- Verified on `b7b1e2b`: CI green; browser 33/33. Several earlier browser runs stalled under external machine load (VM, iOS simulator, contactsd) - not code failures.
- Docker cleaned at the owner's request: removed stale ziyrak/owly images, exited containers, dangling volumes and build cache (~60 GB). Kept: ziyrak-l11-pg, ziyrak-l12-redis (test infra), owly-db-1 and its volumes (shared dev data).
- Continuation: L4.1b per design Revision 2 (new worktree). Owner inputs still open: backup RPO/RTO, alert routing, incident owners, offboarding, OpenAI key for L1.4 evaluation, task sessions with intended users, L4.2 commercial decisions.
- Leftovers needing owner OK to delete: worktrees owly-l1-1/-l1-2/-l1-3/-l1-4/-l2-1/-l2-2/-l3-1/-l3-2/-l4-1; many ziyrak_acceptance_* DBs; /private/tmp/ziyrak-l*-acc* dirs.
