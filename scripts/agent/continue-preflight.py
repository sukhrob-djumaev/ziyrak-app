#!/usr/bin/env python3
"""Read-only Codex/Claude orientation: 0 context present, 2 incomplete, 3 owner STOP.

Never starts implementation or proves runtime/deployment readiness.
"""
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def git(*args):
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), *args],
                            env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
                            text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError("Git inspection failed; verify repository access")
    return result.stdout.strip()


def main():
    os.environ["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        if Path(git("rev-parse", "--show-toplevel")).resolve() != ROOT:
            raise RuntimeError("Script is not in its repository root")
        required = ("AGENTS.md", "CLAUDE.md", "PLAN.md", ".agent/CURRENT.md", ".agent/HANDOFF.md")
        missing = [name for name in required if not (ROOT / name).is_file()]
        print("== Ziyrak read-only continuation preflight ==")
        print(f"Checkout: {ROOT}")
        status = git("status", "--short", "--branch").splitlines()
        print("\n".join(status[:20]))
        if len(status) > 20:
            print(f"... {len(status) - 20} more status lines; inspect the full diff before edits.")
        print("-- recent commits\n" + git("log", "-4", "--oneline"))
        print("-- worktrees\n" + git("worktree", "list"))
        common = Path(git("rev-parse", "--git-common-dir"))
        if not common.is_absolute():
            common = ROOT / common
        stops = {ROOT / ".agent/STOP"}
        coordinator = ROOT
        if common.resolve().name == ".git":
            coordinator = common.resolve().parent
            stops.add(coordinator / ".agent/STOP")
        coordinator_state = coordinator / ".agent/CURRENT.md"
        if coordinator_state.is_file():
            coordinator_text = coordinator_state.read_text()
            match = re.search(r"(?m)^- Active checkout: (.+)$", coordinator_text)
            if match and match[1].strip() != "none":
                active = Path(match[1].strip().strip("`"))
                worktrees = {}
                for entry in git("worktree", "list", "--porcelain").split("\n\n"):
                    lines = entry.splitlines()
                    if lines and lines[0].startswith("worktree "):
                        branch = next((line[len("branch refs/heads/"):] for line in lines
                                       if line.startswith("branch refs/heads/")), None)
                        worktrees[Path(lines[0][len("worktree "):]).resolve()] = branch
                if not active.is_absolute() or not active.is_dir() or active.resolve() not in worktrees:
                    print("CONTEXT_MISSING: recorded active checkout is unavailable; reconcile it, do not start a duplicate task.")
                    return 2
                branch_match = re.search(r"(?m)^- Active branch: (.+)$", coordinator_text)
                expected_branch = branch_match[1].strip().strip("`") if branch_match else None
                if not expected_branch or expected_branch == "none" or worktrees[active.resolve()] != expected_branch:
                    print("CONTEXT_MISSING: active branch is absent or disagrees with its worktree; reconcile before edits.")
                    return 2
                stops.add(active / ".agent/STOP")
                if active.resolve() != ROOT:
                    print(f"RESUME_CHECKOUT: {active}; read its CURRENT/HANDOFF and Git before implementation.")
        if any(path.exists() for path in stops):
            print("OWNER_STOP: leave the marker intact; no implementation or background loop.")
            return 3
        if missing:
            print("CONTEXT_MISSING: " + ", ".join(missing))
            print("Reconstruct from PLAN/Git evidence before implementation; never guess scope.")
            return 2
        current = (ROOT / ".agent/CURRENT.md").read_text()
        print("-- CURRENT (read HANDOFF and the selected plan criteria next)")
        print("\n".join(current.splitlines()[:60]))
        if len(current.splitlines()) > 60:
            print("NOTE: CURRENT exceeds 60 lines; compact explicitly after reconciliation.")
        branch = git("branch", "--show-current")
        if ROOT == coordinator or branch in ("main", "master") or not branch:
            print("WORKTREE_REQUIRED: do product implementation/install/build in an isolated task worktree.")
        print("CONTEXT_OK: instructions exist; this is NOT runtime, CI, or deployment acceptance.")
        print("Resume recorded in-flight work first. One lead at a time; do not run Claude and Codex concurrently on the task.")
        return 0
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"CONTEXT_UNAVAILABLE: {error}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
