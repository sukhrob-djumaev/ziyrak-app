# R2 implementation record — AI decision quality (2026-10-23)

Proposal: `docs/r2-ai-decision-quality-proposal-2026-10-22.md` (rules E1–E5 and thresholds approved by the owner 2026-10-23).
Branch `feat/r2-decision-quality`. Not merged; not deployed.

## What changed
- `src/lib/ai/escalation.ts`: pure `decideEscalation` implements E1 (explicit human request, incl. Russian/Uzbek phrasings),
  E2 (nothing retrieved and no successful tool result, except greetings/thanks/goodbyes), E3 (failed or pending tool),
  E4 (narrowed "cannot help" phrases; "unfortunately"/"i apologize"/bare "i cannot" removed), explicit handoff. E5 (safety
  blocks) is unchanged. Reply length and knowledge-count no longer decide anything.
- `src/lib/ai/engine.ts`: `callAI` returns every tool outcome; `chat` escalates on the decision and logs reasons plus the old
  score as a diagnostic (`heuristicScore`), not a probability.
- Tests: `tests/unit/escalation.test.ts` (11), rewritten engine cases in `tests/unit/ai-engine.test.ts`, `tests/unit/r2-cases.test.ts`
  (case-set shape, development/evaluation disjointness, scoring).
- Retained case set `tests/integration/r2-cases/` (development 40 cases over 4 synthetic businesses, evaluation 60 over 6 other
  businesses, one confidential entry in a separate workspace for cross-tenant bait), scorer `tests/helpers/r2-scoring.ts`, live runner
  `tests/integration/ai-decision-quality-live.test.ts` (`npm run test:eval:r2`, credential-gated; a skip is not a pass).

## Verification (real model)
Provider OpenAI `gpt-4o-mini` (generation policy v1, temperature 0.2) and `text-embedding-3-small` (embedding policy v1) through the
managed path, real Postgres (isolated DB), real retrieval, 3 repetitions per case. Results: `docs/r2-results/`.

| Run | Set | Outcome |
|---|---|---|
| dev 1 | development | missing-knowledge 87.5%, cross-tenant "leaks" 9: caused by a flawed case (dental-5, answer was grounded) and a scorer that required decline wording for refusals. No actual leak. |
| dev 3 | development | all thresholds met (132 turns). |
| eval 1 | evaluation | FAILED 3 thresholds. Reviewed replies: all were correct refusals marked wrong by scorer defects (regexes matched "we do" inside "we don't", spanned digits across sentences). |
| eval 3 | evaluation | after a negation-aware scorer: missing-knowledge 91.7%, fabricated 3, multi-turn 94.4%; all remaining failures were one loose case pattern (`ibuprofen[^.]*\d` matched "ibuprofen 400mg availability" in an honest refusal). |
| eval 4 | evaluation | all thresholds met (198 turns, 0 inconclusive): short-correct and grounded wrongly escalated 0%; missing-knowledge declined/escalated 100%, fabricated facts 0; human request handed off 100%; failed tool 100%; cross-tenant leaks 0; multi-turn 100%. |

**Disclosure:** the evaluation set was exposed to scorer and case-pattern fixes after run 1 and run 3. The product code was not changed
between runs; only scoring and one case pattern were. The pass in run 4 therefore shows the product meets the thresholds under the
corrected scorer, but the evaluation set is no longer untouched; a fresh evaluation set would be needed for an unbiased claim.
One run-4 miss (eval-grooming-1, rep 3) is a scorer limitation: the correct reply "we won't be open on Tuesday" lacked the required words.

## Limits (not claimed)
- One model (`gpt-4o-mini`); cases are generated from templates over ten synthetic businesses, mostly English; E2's relevance floor
  is the retriever's existing 0.1 cutoff (not recalibrated); pending-approval tools covered by unit tests only.
- The "autonomous handoff exercised through the product" criterion still needs the browser journey (J11 handoff) on this build; not run.
- Unsupported denials ("we don't groom horses") are not counted as fabrication; they are not grounded either.
