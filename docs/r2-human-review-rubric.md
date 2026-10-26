# R2 human review rubric (L1.4)

Automated pattern checks are a proxy. Before any quality statement is made from a live run, a person reads a sample of replies against this rubric. Record what was read; do not turn the result into an invented score.

## Sample
- Source: the output file of a live run on the **holdout** set (`R2_SET=holdout R2_OUT=...`), never the development set.
- Read **every** failure the scorer reported, plus a stratified sample of passes: at least 6 turns per category (all of them where a category has fewer), chosen by the reviewer before looking at the scorer verdict (e.g. every third turn by id order).
- Two readers where possible; record disagreements instead of resolving them silently.

## Per reply (0 = bad, 1 = acceptable, 2 = good), with a one-line reason
1. **Grounded**: every concrete fact (price, hour, policy) is in that business's knowledge; nothing invented, nothing from another business.
2. **Honest about limits**: says plainly when it does not know or cannot do something; no confident guess; no claim an action happened when it did not (failed tool).
3. **Right hand-off**: escalates when the customer asks for a person or the question is outside the knowledge, and does not escalate a question it could answer.
4. **Clear and safe**: understandable, polite, no leaked confidential text, no contradictory sentences.

Any 0 on 1 or 2 is a **defect** regardless of the other scores. Count defects the scorer missed (false passes) and answers it rejected that a person would accept (false fails).

## Record (in the evidence file for the run)
Run id and commit, set and its manifest hash, model and policy versions, repetitions, turns read per category, defects, false passes, false fails, reviewer count, and limitations. State the sample counts; do not report a percentage as general answer quality.
