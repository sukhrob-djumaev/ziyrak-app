# Handoff - L1.4b gate passed, PR open (2026-11-07)
PR #75 merged (`11da5db`). Gate on fresh holdout42 (r48): 8/8, 150 turns, 0 inconclusive/scorer/rule fails. Regression 14 cases x 3 reps 42/42. Owner blind review 13/13 (10 stratified + 3 allergen).
This branch (`test/l1.4b-holdout41`, worktree `ziyrak-l14r`): frozen holdout41 (consumed) and holdout42, sampler always includes high-risk turns, evidence `docs/evidence/l1.4b-holdout42-gate-2026-11-07.md`.
Continuation: wait for exact-head CI, merge pinned to head (no browser trigger: tests/eval tooling only), push main, recheck CI.
Cleanup pending owner OK: container `ziyrak-l14r-pg` (:55432), worktree `ziyrak-l14r`. Open: hairsalon-7 inconclusives from h18 untraced. Do not start L7.
