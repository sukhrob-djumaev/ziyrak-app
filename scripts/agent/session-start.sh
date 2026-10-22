#!/usr/bin/env bash
# SessionStart hook: print a compact orientation so the agent does not spend turns and tokens
# re-deriving it, and keep the state files small. Output goes into the session context.
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" 2>/dev/null || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
echo "== Ziyrak session orientation =="
git status --short --branch | head -15
echo "-- recent commits"
git log -6 --oneline
echo "-- worktrees"
git worktree list | sed 's/ \+/ /g' | head -15

# Auto-archive old state sections, but never dirty the main checkout that serves the live worker.
case "$branch" in
  main|master) ;;
  *) python3 scripts/agent/archive-state.py ;;
esac

cur=$(wc -l < .agent/CURRENT.md 2>/dev/null || echo 0)
plan=$(wc -l < PLAN.md 2>/dev/null || echo 0)
echo "-- .agent/CURRENT.md (${cur} lines)"
head -45 .agent/CURRENT.md 2>/dev/null
[ "$cur" -gt 80 ] && echo "WARN: CURRENT.md over 80 lines; run python3 scripts/agent/archive-state.py on a non-main branch."
[ "$plan" -gt 1500 ] && echo "WARN: PLAN.md is ${plan} lines; archive finished material to docs/."
echo "-- reading rule: PLAN.md live sections only; grep docs/architecture-reference.md and docs/implementation-history.md by heading, never read them whole."
exit 0
