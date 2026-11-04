# Handoff - L1.4 holdout28 gate (2026-11-04)

- Branch `fix/l1.4-review-h23` (worktree `/Users/sukhrob/Development/Repos/JS/ziyrak-l14r`): h23 review fixes (act on given contact, state number, priority only if returned, medical pointer, no hand-off offers), price-answers-"what is X" clause, tool-call-before-reply on injury; holdouts 24-28 frozen.
- Gate: holdout28 valid, 8/8 (0 inconclusive, 150 turns). Evidence: `docs/evidence/l1.4-holdout28-gate-2026-11-04.md`. Pattern proxy only.
- Next: merge PR when exact-head CI green; owner reviews blind sheet `~/Documents/ziyrak-review/l1.4-r12`. L1.4 closes only on that pass.
- Owner questions pending: authority-claim injection policy (recommend decline); does "grader flakiness" mean the pattern scorer or an LLM judge.
- Not done: hairsalon-7 inconclusive trace; ticket-priority wording check.
