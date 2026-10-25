#!/usr/bin/env python3
"""Read-only CI snapshot: 0 success, 1 failed, 2 unavailable, 3 pending.

This cannot prove browser acceptance or authorize a merge.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = None


class Unavailable(Exception):
    pass


def repository_identity():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    try:
        result = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), "remote", "get-url", "origin"],
                                env=env, text=True, capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Unavailable("Cannot inspect this checkout's origin") from error
    if result.returncode:
        raise Unavailable("This checkout needs a configured GitHub origin")
    remote = result.stdout.strip()
    scp = re.fullmatch(r"git@([A-Za-z0-9.-]+):(.+)", remote)
    if scp:
        host, path = scp.groups()
    else:
        try:
            url = urlsplit(remote)
            if url.scheme not in ("https", "ssh") or not url.hostname:
                raise ValueError("unsupported origin")
            host, path = url.hostname, url.path.lstrip("/")
        except ValueError as error:
            raise Unavailable("Origin must identify a GitHub HTTPS/SSH repository") from error
    path = path.removesuffix(".git")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", host) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", path):
        raise Unavailable("Cannot safely resolve repository identity from origin")
    return f"{host.lower()}/{path}"


def github(args, allowed_codes=(0,), with_code=False):
    if REPOSITORY is None:
        raise Unavailable("Repository identity was not established")
    env = {k: v for k, v in os.environ.items() if k not in ("GH_REPO", "GH_HOST") and not k.startswith("GIT_")}
    try:
        result = subprocess.run(["gh", *args, "--repo", REPOSITORY], cwd=ROOT, env=env,
                                text=True, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Unavailable("GitHub CLI unavailable or timed out") from error
    if result.returncode not in allowed_codes:
        raise Unavailable("GitHub query failed; check authentication/network separately")
    try:
        data = json.loads(result.stdout)
        return (data, result.returncode) if with_code else data
    except (ValueError, TypeError) as error:
        raise Unavailable("GitHub returned invalid JSON") from error


def full_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def pr_snapshot(number):
    info = github(["pr", "view", number, "--json", "state,headRefOid,mergeStateStatus,baseRefName"])
    if not isinstance(info, dict) or not full_sha(info.get("headRefOid")):
        raise Unavailable("Missing or invalid PR head")
    if any(not isinstance(info.get(k), str) or not info[k] for k in ("state", "mergeStateStatus", "baseRefName")):
        raise Unavailable("Incomplete PR snapshot")
    return info


def check_pr(number, merge=False):
    before = pr_snapshot(number)
    checks, check_code = github(["pr", "checks", number, "--json", "name,workflow,state,bucket"], (0, 1, 8), True)
    after = pr_snapshot(number)
    if before != after:
        return 3, "PR head/base/state changed during check; retry a stable snapshot"
    if merge and (after["state"] != "OPEN" or after["baseRefName"] != "main" or after["mergeStateStatus"] != "CLEAN"):
        return 1, "PR must be OPEN, target main and have CLEAN merge state"
    if not isinstance(checks, list) or any(not isinstance(c, dict) for c in checks):
        raise Unavailable("Invalid PR check list")
    if not checks:
        return 3, "No PR checks reported"
    if any(not all(isinstance(c.get(k), str) and c[k] for k in ("name", "state", "bucket")) for c in checks):
        raise Unavailable("Incomplete PR check result")
    # Keep this explicit requirement in sync with .github/workflows/ci.yml.
    if not any(c.get("workflow") == "CI" and c["name"] == "build" for c in checks):
        return 3, "Required CI/build check is absent"
    if any(c["bucket"] not in ("pass", "pending") for c in checks):
        return 1, "A check failed, was cancelled, skipped or has an unknown result"
    if any(c["bucket"] == "pending" for c in checks):
        return 3, "Checks pending"
    if any(c["state"] != "SUCCESS" for c in checks):
        return 1, "Every check must explicitly succeed; neutral/skipped is not success"
    if check_code != 0:
        raise Unavailable("Check command exit code disagrees with successful results")
    sha = after["headRefOid"]
    return 0, f"MERGE_OK {sha}" if merge else f"CI_GREEN pr {number} head {sha}"


def check_sha(sha):
    if not full_sha(sha):
        raise Unavailable("sha mode requires a full lowercase 40-character commit SHA")
    fields = "headSha,workflowName,workflowDatabaseId,databaseId,event,status,conclusion"
    runs = github(["run", "list", "--commit", sha, "--limit", "100", "--json", fields])
    if not isinstance(runs, list) or any(not isinstance(r, dict) for r in runs):
        raise Unavailable("Invalid workflow run list")
    if len(runs) >= 100:
        raise Unavailable("Run list may be truncated; inspect complete results before accepting CI")
    if not runs:
        return 3, "No workflow runs reported for exact SHA"
    latest = {}
    for run in runs:
        if run.get("headSha") != sha:
            raise Unavailable("Workflow run does not match requested SHA")
        for key in ("workflowName", "event", "status"):
            if not isinstance(run.get(key), str) or not run[key]:
                raise Unavailable("Incomplete workflow result")
        for key in ("workflowDatabaseId", "databaseId"):
            if type(run.get(key)) is not int or run[key] <= 0:
                raise Unavailable("Invalid workflow identity")
        key = (run["workflowDatabaseId"], run["event"])
        if key not in latest or run["databaseId"] > latest[key]["databaseId"]:
            latest[key] = run
    runs = list(latest.values())
    if not any(r["workflowName"] == "CI" for r in runs):
        return 3, "Required CI workflow is absent"
    if any(r["status"] == "completed" and r.get("conclusion") != "success" for r in runs):
        return 1, "A workflow did not succeed (including skipped/neutral)"
    if any(r["status"] != "completed" for r in runs):
        return 3, "Workflows pending or awaiting action"
    # Overall workflow success can hide a skipped required job. Inspect the exact CI run.
    for run in runs:
        if run["workflowName"] != "CI":
            continue
        detail = github(["run", "view", str(run["databaseId"]), "--json", "headSha,jobs"])
        if not isinstance(detail, dict) or detail.get("headSha") != sha:
            raise Unavailable("CI job snapshot does not match requested SHA")
        jobs = detail.get("jobs")
        if not isinstance(jobs, list) or not jobs or any(not isinstance(j, dict) for j in jobs):
            raise Unavailable("CI job list is absent or invalid")
        if not any(j.get("name") == "build" for j in jobs):
            return 1, "Required CI/build job is absent"
        if any(j.get("status") != "completed" or j.get("conclusion") != "success" for j in jobs):
            return 1, "Every CI job must explicitly complete successfully"
    return 0, f"CI_GREEN sha {sha}"


def main():
    global REPOSITORY
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("pr", "sha", "merge"))
    parser.add_argument("ref")
    args = parser.parse_args()
    try:
        REPOSITORY = repository_identity()
        if args.kind != "sha" and not re.fullmatch(r"[1-9][0-9]*", args.ref):
            raise Unavailable("PR number must be a positive integer")
        code, message = check_sha(args.ref) if args.kind == "sha" else check_pr(args.ref, args.kind == "merge")
    except Unavailable as error:
        code, message = 2, str(error)
    if code:
        prefix = {1: "CI_FAILED", 2: "CI_UNAVAILABLE", 3: "CI_PENDING"}[code]
        if args.kind == "merge":
            prefix = "GATE_ERROR" if code == 2 else "GATE_BLOCKED"
        print(f"{prefix} {args.kind} {args.ref}: {message}; repo {REPOSITORY or 'unresolved'}")
    else:
        print(f"{message} repo {REPOSITORY}")
        if args.kind == "merge":
            print("CI gate only: separately verify combined-build browser evidence and merge authorization.")
    return code


if __name__ == "__main__":
    sys.exit(main())
