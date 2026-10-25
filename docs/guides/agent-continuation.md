# Start or resume Ziyrak with Claude or Codex

The owner approved LP-2026-10-25 launch preparation through L6. The next implementation task is L1.1; [PLAN](../../PLAN.md) and [CURRENT](../../.agent/CURRENT.md) govern future changes. No previous conversation or custom scheduler is required.

## Start

Open this repository in either application and send **`continue`**. For a fresh terminal session, choose one:

```sh
cd /Users/sukhrob/Development/Repos/JS/owly
claude "continue"
```

```sh
codex -C /Users/sukhrob/Development/Repos/JS/owly "continue"
```

Claude also has `/ziyrak continue` and read-only `/ziyrak status`. Plain `continue` is the shared path. Use the installed client's normal account/model/permission configuration; do not bypass sandbox/approval controls or use a mode that skips repository instructions. Local CLI help verified these invocation forms on 2026-10-25; account access remains a client prerequisite.

Only one lead should work on this task at a time. To switch tools, stop at a recorded checkpoint, then open the recorded task checkout in the other tool. A new session is fine: tracked state, not the old transcript, is the continuation source.

## What continuation does

1. Read AGENTS (Claude imports it through CLAUDE.md), the local preflight, CURRENT/HANDOFF and selected PLAN criteria. Reuse fresh hook output where present; Codex can call the same preflight explicitly.
2. Check the coordinator's active checkout/branch and Git worktrees. Resume in-flight changes/verification before starting another task. Preserve dirty work. Missing/stale pointers are reconciled against Git/evidence, never erased to manufacture a clean tree.
3. For new product work, create an isolated task worktree and record its absolute path/branch in the coordinator CURRENT before editing/installing/building. Detailed progress lives in that task checkout; the coordinator remains a routing pointer. Never alter the live worker's dependencies/build or protected port 7700.
4. State the module contract and exact criteria; write required failing tests first; implement and verify using the required layers and independent reviews. Continue eligible L1–L6 work without routine approval prompts.
5. Commit tracked handoff/evidence and update pointers at work-unit boundaries. Stop for real missing inputs, architecture/product decisions, protected/destructive actions or the L7 release/live-money boundary. A provider blocker stops only dependent work.

Optional local orientation, with no network, installation, database or process changes:

```sh
python3 scripts/agent/continue-preflight.py
```

`CONTEXT_OK` means required routing files exist, not that the product or deployment passed. The helper reports dirty files and linked worktrees; it does not enforce a cross-process agent lock. Do not launch two writers. `.agent/STOP` in the coordinator or active task checkout stops continuation; leave it intact until an explicit owner resumption/removal instruction. There is no STOP marker at this preparation checkpoint.

## Verification helpers and limits

`python3 scripts/agent/test_workflow.py` runs synthetic workflow safety regressions without app dependencies, databases or live GitHub. `session-start.sh` only displays preflight context; it never archives or edits state. Archive old state explicitly after reconciliation when useful.

`ci-wait.sh pr <number>|sha <full-sha> [minutes]` and `merge-gate.sh <number>` use structured GitHub results. Queries are pinned to the GitHub origin of the helper’s checkout, even from another directory or with stale GH_REPO/GH_HOST; verdicts include repository identity. They require the current CI/build gate and reject unavailable/empty/malformed/skipped/neutral/failed results as success. PR checks are bracketed by matching head/base/state snapshots; an authorized merge still pins that head. SHA mode inspects the latest reported runs per workflow/event and their CI jobs; changes to CI names must update the helper/tests. **MERGE_OK proves only the CI portion.** Combined-build browser evidence and standing merge authorization remain separate; no helper merges or pushes.

Ignored `.agent/progress/` logs and Claude-only `usage.py` are optional conveniences. Store decisive evidence and next steps in tracked files; never make Codex depend on a Claude transcript or on invented scheduling/notification tools. This preparation validates scripts and routing, not a fresh model-driven end-to-end implementation session or production acceptance.

## References

Current official guidance supports repository instructions and lightweight entrypoints: [OpenAI AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Claude memory/imports](https://code.claude.com/docs/en/memory), [Claude skills](https://code.claude.com/docs/en/skills) and [SessionStart hooks](https://code.claude.com/docs/en/hooks#sessionstart). Local files and the installed clients were checked as well; neither tool needs the other's session history.
