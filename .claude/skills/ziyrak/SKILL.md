---
name: ziyrak
description: Run the Ziyrak plan one task at a time from .agent/CURRENT.md and PLAN.md's live board, unattended. Use for "/ziyrak start", "/ziyrak continue", "/ziyrak status", or "/loop /ziyrak continue" (runs task after task by itself until a real blocker).
---

# Ziyrak: one task per invocation

`AGENTS.md` and `PLAN.md` govern; this skill only sequences the work. State lives in files (`.agent/CURRENT.md`,
`.agent/HANDOFF.md`, Git), so a crash, restart or compaction loses nothing: the next `/ziyrak continue` resumes.

**This conversation is a dispatcher, not a worker.** It picks the task, hands it to one fresh helper, records the
result, merges when the gates allow, and schedules the next wakeup. It never reads code, logs, diffs or screens
itself (use the `log-triage` agent or `tail`/`grep`). Each tool call re-sends the whole context, so stay small.

Arguments: `start` | `continue` (default) | `status`.

## 0. Hard rules

1. Work from the main folder `/Users/sukhrob/Development/Repos/JS/owly` on `main`; do code, builds and acceptance in
   a git worktree. Never touch port 7700 or the live worker checkout. Never kill processes by name.
2. One task and one helper at a time. No parallel browser runs (one shared machine, Flutter load).
3. Never push tags, deploy, release, force-push, delete DBs/worktrees/branches, or start a milestone/phase beyond
   the standing authorization in `CURRENT.md`.
4. Never put secrets in prompts, logs, commits or state files. Inspect credentials without printing values.
5. A skip is not a pass. A red, pending or skipped check is never a pass. Stand-ins, Graph acceptance and
   recipient-visible replies prove different things.
6. Surface protocol conflicts (PLAN rule 11); do not resolve them silently.

## 1. Every invocation starts like this

1. `git rev-parse --show-toplevel` ends in `owly`; branch is `main` or a task branch named in CURRENT. Else stop.
2. If `.agent/STOP` exists, stop the loop (§5) and report "stopped by the owner".
3. `uptime`: if the load average is above 12, wait 20 minutes (§5) before any browser/acceptance task.
4. Keep the Mac awake: if `pgrep -f "caffeinate -dims"` finds nothing, start `caffeinate -dims` in the background.
5. Read `.agent/CURRENT.md` (≤ ~60 lines) and the live board in `PLAN.md` (grep the rows; never read PLAN whole).
   Never read `docs/architecture-reference.md`, `docs/milestone-archive.md` or `docs/implementation-history.md` whole.
6. `git status --short --branch`, `git fetch`, `gh pr list`, `gh run list --limit 3`.
7. `status`: print Status, Next action, blockers and the last CI results, then stop without a wakeup.

## 2. Pick the task

1. Resume anything marked in progress in CURRENT (open PR, branch, unfinished verification) before new work.
2. Otherwise take the first eligible item under CURRENT "Next action", in PLAN board order, inside the approved
   milestone. If the next item needs an owner decision or an input only the owner can give (phone, credential,
   real mailbox, waiver), record it under **Needs you**, skip it, and take the next independent item.
3. Write the task and UTC start time under **In flight** in CURRENT.

## 3. Do the task: one fresh helper

Start one `general-purpose` helper (Agent tool). The packet is small: objective, constraints (§0, the worktree to
use, what is read-only), the exact acceptance criteria and PLAN sections it needs, the verification path, and
where to write progress (`.agent/progress/<task>.md`, git-ignored: updated after every step, lists temporary
changes still active, DBs/worktrees in use, what is next). Do not paste the transcript.

The helper owns implementation, verification and evidence, follows `AGENTS.md`, and sends long logs through
`log-triage`. For behaviour changes in auth/tenant/secrets/crypto/webhooks/payments/user input it requests an
independent security review as AGENTS.md says. If its context passes ~150k it updates the progress file and returns
`CONTINUE <path>`; the dispatcher starts a fresh helper that reads the file first.

It returns at most 15 lines: result, commits/branches/PR, checks run with layer and build identity, failures,
Needs-you items, files changed, and `DONE` or `CONTINUE <path>`.

## 4. Record, merge, tag

The dispatcher then:
1. Applies the result to CURRENT (small) and HANDOFF (latest session only); runs
   `python3 scripts/agent/archive-state.py` if CURRENT passes ~60 lines. Commit state with a Conventional Commit.
2. **Merge** a PR into main only when, on its exact head commit: CI is green AND the browser/acceptance run the plan
   requires is green on the combined build (standing authorization in CURRENT). Use
   `gh pr merge <n> --merge --match-head-commit <sha>`, `git pull --ff-only`, `git push origin main`, then re-check
   CI on the new head. Never merge on red, pending or skipped.
3. **Tags** only where the owner approved them in CURRENT; tag the CI-verified merge commit, push the tag.
4. On a failed check: one fix attempt inside scope, rerun the affected check. Same failure twice, or three errors
   in a row, is a blocker (§5).

## 5. Next task, or stop

- **Inside `/loop`:** more eligible work, no stop → `ScheduleWakeup` `delaySeconds: 60`, `prompt: "/loop /ziyrak continue"`,
  reason naming the next task.
- **Waiting on CI/PR/machine load:** wake in 600 s (CI ~10 min) or 1200 s (load).
- **Stop** (`ScheduleWakeup stop: true`, then `PushNotification` with one line) on: `.agent/STOP`; red CI or failed
  required check after the fix attempt; a confirmed external blocker with no eligible independent task; a necessary
  architecture change or unresolved product choice; anything §0 forbids; milestone complete. Say why, what the
  owner must do, and which file to read.
- **Not inside `/loop`:** end with one line naming the next task.

## 6. Context size

The worker is started with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` (`scripts/agent/start-worker.sh`), so it
compacts itself and the loop goes on. After a compaction re-read only §1. If the context stays above ~400k,
finish bookkeeping, stop the loop and ask the owner to restart the worker.
