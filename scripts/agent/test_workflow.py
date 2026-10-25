"""Workflow safety regressions. Synthetic GitHub responses only; no app, DB or network."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40
OTHER_SHA = "b" * 40


class CIGates(unittest.TestCase):
    def run_gate(self, script, args, fixture):
        with tempfile.TemporaryDirectory(prefix="ziyrak-ci-fixture-") as folder:
            tmp = Path(folder)
            data = tmp / "fixture.json"
            data.write_text(json.dumps(fixture))
            own = tmp / "source"
            (own / "scripts/agent").mkdir(parents=True)
            for name in ("ci-status.py", "ci-wait.sh", "merge-gate.sh"):
                shutil.copyfile(ROOT / "scripts/agent" / name, own / "scripts/agent" / name)
            git_env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            subprocess.run(["git", "-C", str(own), "init", "-q"], env=git_env, check=True)
            subprocess.run(["git", "-C", str(own), "remote", "add", "origin",
                            "https://github.com/example/ziyrak-workflow-fixture.git"], env=git_env, check=True)
            gh = tmp / "gh"
            gh.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
f = json.loads(pathlib.Path(os.environ["WORKFLOW_FIXTURE"]).read_text())
a = sys.argv[1:]
if f.get("assert_target"):
    if ("--repo" not in a or a[a.index("--repo") + 1] != "github.com/example/ziyrak-workflow-fixture"
        or os.getcwd() != os.environ["WORKFLOW_SCRIPT_ROOT"] or os.environ.get("GH_REPO")):
        print("synthetic wrong repository selection", file=sys.stderr); sys.exit(2)
if f.get("malformed"):
    print("{invalid"); sys.exit(0)
if a[:2] == ["run", "list"]:
    if f.get("error"):
        print("synthetic GitHub unavailable", file=sys.stderr); sys.exit(1)
    print(json.dumps(f.get("runs", []))); sys.exit(0)
if a[:2] == ["run", "view"]:
    print(json.dumps({"headSha": f.get("job_sha", "a" * 40), "jobs": f.get("jobs", [
        {"name": "build", "status": "completed", "conclusion": "success"}])})); sys.exit(0)
if a[:2] == ["pr", "view"]:
    count = pathlib.Path(os.environ["WORKFLOW_FIXTURE"] + ".count")
    n = int(count.read_text()) if count.exists() else 0
    count.write_text(str(n + 1))
    info = dict(f["pr"])
    if n and f.get("next_sha"): info["headRefOid"] = f["next_sha"]
    if "--json" in a and a[a.index("--json")+1] == "headRefOid":
        print(info["headRefOid"])
    elif "-q" in a:
        print("\\t".join(info[k] for k in ("state", "headRefOid", "mergeStateStatus", "baseRefName")))
    else: print(json.dumps(info))
    sys.exit(0)
if a[:2] == ["pr", "checks"]:
    if "--json" in a: print(json.dumps(f.get("checks", [])))
    else: print("build\\tpass\\t1s\\thttps://example.invalid")
    sys.exit(f.get("checks_rc", 0))
print("unexpected fixture command", file=sys.stderr); sys.exit(2)
''')
            gh.chmod(0o755)
            env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}", "WORKFLOW_FIXTURE": str(data),
                   "GH_REPO": "wrong-owner/wrong-project", "WORKFLOW_SCRIPT_ROOT": str(own.resolve())}
            return subprocess.run(["bash", str(own / "scripts/agent" / script), *args],
                                  cwd=tmp, env=env, text=True, capture_output=True, timeout=8)

    def pr(self, state="SUCCESS", bucket="pass"):
        return {"pr": {"state": "OPEN", "headRefOid": SHA, "mergeStateStatus": "CLEAN", "baseRefName": "main"},
                "checks": [{"name": "build", "workflow": "CI", "state": state, "bucket": bucket}]}

    def workflow(self, status="completed", conclusion="success", sha=SHA, name="CI", run_id=2):
        return {"headSha": sha, "workflowName": name, "workflowDatabaseId": 1,
                "databaseId": run_id, "event": "push", "status": status, "conclusion": conclusion}

    def assert_not_green(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("CI_GREEN", result.stdout)
        self.assertNotIn("MERGE_OK", result.stdout)

    def test_sha_error_is_not_green(self):
        self.assert_not_green(self.run_gate("ci-wait.sh", ["sha", SHA, "0"], {"error": True}))

    def test_sha_non_success_is_not_green(self):
        for status, conclusion in [("completed", "skipped"), ("completed", "neutral"),
                                   ("waiting", ""), ("completed", "action_required"), ("completed", "failure")]:
            with self.subTest(status=status, conclusion=conclusion):
                self.assert_not_green(self.run_gate("ci-wait.sh", ["sha", SHA, "0"],
                                                   {"runs": [self.workflow(status, conclusion)]}))

    def test_sha_wrong_identity_is_not_green(self):
        self.assert_not_green(self.run_gate("ci-wait.sh", ["sha", SHA, "0"],
                                           {"runs": [self.workflow(sha=OTHER_SHA)]}))

    def test_sha_missing_required_workflow_is_not_green(self):
        for runs in [[], [self.workflow(name="Publish")]]:
            self.assert_not_green(self.run_gate("ci-wait.sh", ["sha", SHA, "0"], {"runs": runs}))

    def test_sha_success_and_latest_run(self):
        result = self.run_gate("ci-wait.sh", ["sha", SHA, "0"],
                               {"runs": [self.workflow(), self.workflow(conclusion="failure", run_id=1)]})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"CI_GREEN sha {SHA}", result.stdout)

    def test_invalid_json_is_not_green(self):
        for script, args in [("ci-wait.sh", ["sha", SHA, "0"]), ("merge-gate.sh", ["12"])]:
            self.assert_not_green(self.run_gate(script, args, {"malformed": True}))

    def test_sha_skipped_or_missing_build_is_not_green(self):
        for jobs in [[], [{"name": "build", "status": "completed", "conclusion": "skipped"}],
                     [{"name": "other", "status": "completed", "conclusion": "success"}]]:
            self.assert_not_green(self.run_gate("ci-wait.sh", ["sha", SHA, "0"],
                                               {"runs": [self.workflow()], "jobs": jobs}))

    def test_sha_job_wrong_head_is_not_green(self):
        self.assert_not_green(self.run_gate("ci-wait.sh", ["sha", SHA, "0"],
                                           {"runs": [self.workflow()], "job_sha": OTHER_SHA}))

    def test_merge_no_checks_is_not_green(self):
        fixture = self.pr(); fixture["checks"] = []
        self.assert_not_green(self.run_gate("merge-gate.sh", ["12"], fixture))

    def test_merge_skipped_or_neutral_is_not_green(self):
        for state, bucket in [("SKIPPED", "skipping"), ("NEUTRAL", "pass"), ("PENDING", "pending")]:
            self.assert_not_green(self.run_gate("merge-gate.sh", ["12"], self.pr(state, bucket)))

    def test_pr_changed_head_is_not_green(self):
        for script, args in [("ci-wait.sh", ["pr", "12", "0"]), ("merge-gate.sh", ["12"])]:
            fixture = self.pr(); fixture["next_sha"] = OTHER_SHA
            self.assert_not_green(self.run_gate(script, args, fixture))

    def test_merge_success(self):
        result = self.run_gate("merge-gate.sh", ["12"], self.pr())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"MERGE_OK {SHA}", result.stdout)

    def test_queries_bound_to_script_repository(self):
        for script, args, fixture in [("merge-gate.sh", ["12"], self.pr()),
                                     ("ci-wait.sh", ["sha", SHA, "0"], {"runs": [self.workflow()]})]:
            fixture["assert_target"] = True
            result = self.run_gate(script, args, fixture)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("github.com/example/ziyrak-workflow-fixture", result.stdout)

    def test_nonzero_check_exit_cannot_report_success(self):
        for code in (1, 8):
            fixture = self.pr(); fixture["checks_rc"] = code
            self.assert_not_green(self.run_gate("merge-gate.sh", ["12"], fixture))

    def test_merge_wrong_base_or_state(self):
        for key, value in [("baseRefName", "other"), ("state", "CLOSED"), ("mergeStateStatus", "DIRTY")]:
            fixture = self.pr(); fixture["pr"][key] = value
            self.assert_not_green(self.run_gate("merge-gate.sh", ["12"], fixture))


class Preflight(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="ziyrak-context-fixture-")
        self.addCleanup(self.folder.cleanup)
        self.base = Path(self.folder.name)
        self.repo = self.base / "renamed-project"
        self.repo.mkdir()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.git("init", "-b", "main")
        (self.repo / "scripts/agent").mkdir(parents=True)
        for name in ("continue-preflight.py", "session-start.sh"):
            shutil.copyfile(ROOT / "scripts/agent" / name, self.repo / "scripts/agent" / name)
        (self.repo / ".agent").mkdir()
        for name in ("AGENTS.md", "CLAUDE.md", "PLAN.md", ".agent/HANDOFF.md"):
            (self.repo / name).write_text("Synthetic continuation context\n")
        (self.repo / ".agent/CURRENT.md").write_text("# Current\n- Active checkout: none\n- Active branch: none\n")
        self.git("add", ".")
        self.git("-c", "user.name=Workflow Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], env=self.env,
                              check=True, text=True, capture_output=True, timeout=10)

    def preflight(self, root=None):
        root = root or self.repo
        return subprocess.run(["python3", str(root / "scripts/agent/continue-preflight.py")],
                              env=self.env, text=True, capture_output=True, timeout=10)

    def test_main_read_only(self):
        (self.repo / ".agent/HANDOFF.md").write_text("# Latest session new\nNew\n# Latest session old\nOld\n")
        before = {p.relative_to(self.repo): p.read_bytes() for p in self.repo.rglob("*")
                  if p.is_file() and ".git" not in p.relative_to(self.repo).parts}
        result = subprocess.run(["bash", str(self.repo / "scripts/agent/session-start.sh")],
                                env=self.env, text=True, capture_output=True, timeout=10)
        after = {p.relative_to(self.repo): p.read_bytes() for p in self.repo.rglob("*")
                 if p.is_file() and ".git" not in p.relative_to(self.repo).parts}
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CONTEXT_OK", result.stdout)
        self.assertEqual(before, after)

    def test_missing_context(self):
        (self.repo / ".agent/HANDOFF.md").unlink()
        result = self.preflight()
        self.assertEqual(result.returncode, 2)
        self.assertIn("CONTEXT_MISSING", result.stdout)

    def test_stop_marker(self):
        (self.repo / ".agent/STOP").touch()
        result = self.preflight()
        self.assertEqual(result.returncode, 3)
        self.assertIn("OWNER_STOP", result.stdout)
        self.assertTrue((self.repo / ".agent/STOP").exists())

    def test_linked_worktree_and_coordinator_stop(self):
        linked = self.base / "task-with-different-name"
        self.git("worktree", "add", "-b", "task", str(linked))
        result = self.preflight(linked)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (self.repo / ".agent/STOP").touch()
        self.assertEqual(self.preflight(linked).returncode, 3)

    def test_resume_pointer_and_missing_worktree(self):
        linked = self.base / "resume-task"
        state = self.repo / ".agent/CURRENT.md"
        state.write_text(f"# Current\n- Active checkout: `{linked}`\n- Active branch: `resume-task`\n")
        self.assertEqual(self.preflight().returncode, 2)
        self.git("worktree", "add", "-b", "resume-task", str(linked))
        result = self.preflight()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("RESUME_CHECKOUT", result.stdout)

    def test_active_branch_mismatch(self):
        linked = self.base / "resume-task"
        self.git("worktree", "add", "-b", "actual-task", str(linked))
        (self.repo / ".agent/CURRENT.md").write_text(f"# Current\n- Active checkout: `{linked}`\n- Active branch: `old-task`\n")
        self.assertEqual(self.preflight().returncode, 2)

    def test_coordinator_is_protected_on_feature_branch(self):
        self.git("switch", "-c", "coordinator-feature")
        self.assertIn("WORKTREE_REQUIRED", self.preflight().stdout)


if __name__ == "__main__":
    unittest.main()
