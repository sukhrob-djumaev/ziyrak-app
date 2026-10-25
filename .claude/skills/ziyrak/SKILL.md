---
name: ziyrak
description: Resume or inspect the owner-approved Ziyrak task from PLAN.md and tracked continuation state. Use for /ziyrak run, /ziyrak continue, /ziyrak start, /ziyrak status, or an explicitly requested /loop /ziyrak run.
argument-hint: "[run|continue|start|status]"
disable-model-invocation: false
---

# Ziyrak continuation

This is a thin Claude entrypoint to [AGENTS.md](../../../AGENTS.md) and PLAN.md, not a second workflow or source of approval.
`run`, `start` and `continue` are aliases: resume the first eligible task without restarting historical phases. Plain `continue` also works through CLAUDE.md/AGENTS.md. Follow the current live board, not an old chat or a task hardcoded into this skill.

## Optional owner-requested loop

Use `/loop /ziyrak run` for a self-paced loop, or `/loop 5m /ziyrak run` for a fixed interval. `/loop /ziyrak continue` is equivalent. Model invocation is enabled because scheduled skill calls require it; this does not enlarge the plan's authority or permit creating a schedule without the owner's request.

Each iteration follows the same startup/resume/verification rules below. Never create another loop from inside this skill. On owner STOP, completed approved scope, or a decision/external blocker with no independent eligible work, record the checkpoint and stop/cancel this loop using the runtime's available scheduling controls. Do not cancel unrelated tasks. Plain `/ziyrak run` starts work without creating a schedule.

## Start

1. Read AGENTS.md and the read-only startup preflight output. If absent/stale, run `python3 scripts/agent/continue-preflight.py` from the checkout. A STOP or missing-context result prevents implementation; the hook's zero exit only means its message was displayed.
2. Read tracked CURRENT and HANDOFF. If the coordinator records an active checkout, inspect and resume that checkout's state/Git before creating anything. Never select a repository by directory basename. Honor STOP in the coordinator or task checkout.
3. Inspect Git status/diffs/history and applicable PLAN task/protocol sections. Preserve dirty work; it may be the task to resume. No automatic checkout/reset/stash/cleanup, dependency install, provider test, fetch or process startup.
4. `status` is local/read-only: report selected task, in-flight checkout/branch, next action and recorded blockers. Old CI is historical; only query current CI when needed and label it. Do not start work, caffeinate, schedules or background helpers.

## Continue

The lead owns source review, implementation, integration, verification, Git and state. Work directly by default. Delegate only independent investigation/review or safely independent acceptance per AGENTS; do not create a dispatcher/helper chain or prohibit the lead from reading code/diffs. One lead owns a task; do not run Claude and Codex concurrently on it.

Before product code/install/build, use an isolated task worktree and record its absolute path/branch/task in the coordinator CURRENT. Keep detailed current evidence in the task checkout. State the module contract and verbatim acceptance criteria, then follow tests-first and the selected verification path. The live worker checkout and protected port 7700 remain off limits for product runtime changes.

Complete eligible work in the approved scope without routine reapproval. An ordinary failed test is work to diagnose, not an automatic stop after an arbitrary retry count. Stop identical retries for a confirmed external blocker, record the precise criterion/input/retry condition, and continue independent eligible work. Stop at the plan's real architecture/product/external-action/release boundaries.

Independent security review is required for the boundaries named in AGENTS. Retain the owner's Claude model preference: Sonnet for ordinary work, Opus for security-sensitive work/review, Haiku for optional log triage, when those models are available. Do not select a newer top-tier replacement or alter configured models without the owner’s choice; do not change global configuration or invent a model/tool. Codex uses its own configured model and native reviewers.

## Verify and checkpoint

- Select actual checks from PLAN/package/CI. `verify.sh` is a convenience, not proof of safe DB targeting or complete acceptance. Until L1.1 is accepted, do not run broad cleanup/load scripts without its safeguards.
- `ci-wait.sh pr <n>|sha <full-sha> [minutes]` and `merge-gate.sh <n>` inspect structured current CI. Only explicit successful CI/build and other reported checks can pass. MERGE_OK covers CI only; required combined-build browser evidence and owner authorization remain separate. Pin an authorized merge to the reported head and recheck resulting CI.
- Long logs may live in ignored `.agent/progress/`, but decisions, criterion results, code/build identity, resource ownership and the next step must be in tracked state/evidence before handoff. Never rely solely on ignored logs or Claude transcripts.
- At a completed work unit or genuine blocker, update the task CURRENT/HANDOFF, the coordinator's resume pointer and PLAN only with real new evidence. Review staged diff, commit coherent changes, preserve unrelated work. Do not invent a future hash. Compact/archive explicitly after reconciliation, never as a startup side effect.
- Continue eligible tasks until the approved boundary. If the session ends first, leave a precise checkpoint for either agent. Do not require unsupported scheduling/notification tools or guessed context settings. Optional native loops must obey the same STOP/scope rules and do not expand approval.

No tags, deployment, release, live money, destructive cleanup or new scope follows merely from invoking this skill. Use the current standing authorization exactly as recorded in PLAN/CURRENT.
