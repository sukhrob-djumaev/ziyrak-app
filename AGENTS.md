<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Ziyrak agent workflow

## Authority and scope

- `PLAN.md` governs product architecture, phases, acceptance criteria, security invariants, and development constraints. Follow its **Development Execution Protocol**, **Browser and Live Workflow Verification**, and **Git and Commit Workflow**.
- Git records implementation history; `.agent/CURRENT.md` records the bounded objective and operational status; `.agent/HANDOFF.md` records the latest session. Chat history is optional. State files reference the plan, never replace it or authorize deviations.
- Read dated implementation records as well as phase criteria: the plan's opening draft status and early implementation snapshots are historical. Git/source establish what exists, not permission to change the governed architecture. Surface unresolved conflicts under protocol rule 11.

## Start a session / `continue`

`continue` and `continue current Ziyrak task` mean resume the recorded bounded task, not the next phase.

1. Read this file, then the active phase in `PLAN.md`, its latest implementation records, dependencies, referenced contracts, and the execution/Git protocols. Use `CURRENT.md` as a locator if needed. For new work, map the user's request to the plan first.
2. Read `.agent/CURRENT.md` and `.agent/HANDOFF.md`.
3. Inspect `git status --short --branch`, `git diff`, `git diff --cached`, `git log -8 --oneline`, and relevant tags/history. Preserve existing work; do not reset, switch branches, or stage unrelated changes to obtain a clean baseline.
4. Reconcile the state files against the plan, Git, source, and available evidence. Correct stale state. If files are missing, reconstruct them from that evidence. Do not treat an old test result, running service, credential, or tunnel as current without checking. Ask only if evidence cannot resolve a materially different task or decision.
5. Briefly state the bounded objective, what remains, and the verification path. Before code, restate the module contract and exact applicable acceptance criteria as required by protocol rule 4. Continue useful authorized work without asking for old prompts or routine implementation choices.

## Lead ownership and delegation

- One lead owns context, implementation, integration, final verification, Git, state files, and user communication. Implement directly by default; no planner/architect/coder/tester chain.
- Use native subagents only for independent investigation, architecture uncertainty, review, security review, or independently executable browser/E2E acceptance. Do not delegate trivial or tightly sequential work. Subagents do not edit product code, shared state, or Git by default; coordinate shared runtime use.
- Send a small packet: objective, constraints (including read-only/scope boundaries), relevant paths/commit range, and expected evidence/deliverable. Do not copy the transcript. Reviewers inspect source/diffs/tests independently of the lead's conclusion.
- Consider independent code review after substantial implementation. For behavioral changes involving auth/authz, tenant isolation or DB scoping, secrets, cryptography/signatures, webhooks/external APIs, user-controlled URLs/files/input, payments/billing, or permission boundaries, obtain independent security review when native delegation is available. Fix confirmed in-scope findings and rerun affected checks.
- Both Codex and Claude Code follow this contract using their available native tools; neither requires the other. If delegation is unavailable, perform a separate review pass, label it as lead-only, and record the limitation. Never claim independent review happened; any explicitly required review remains open.
- Collect and integrate every delegated result before finishing. Stop unneeded agents and record unfinished work; leave no orphaned/background task represented as complete.

## Verification and external boundaries

- Choose checks from `PLAN.md` and the actual scripts/configuration. Honor tests-first ordering where required. Use targeted tests, relevant integration/security coverage, and broader regression checks according to scope; compiling alone proves no acceptance criterion.
- Current commands: `npx vitest run <test-paths>`, `npm run test`, `npm run test:signup-seeded`, `npx tsc --noEmit`, `npm run lint -- --max-warnings 0`, `npm run build`. Check `package.json` and `.github/workflows/ci.yml` for drift. Repository/isolation tests require real, isolated Postgres; never aim test cleanup at an acceptance or user database.
- For browser/live work, follow the plan's topology and journey requirements using available tools. `scripts/acceptance/run-all.sh` supplies the full browser suite's dependency order; read its setup scripts before running. Use the real UI where one exists, and verify worker, persistence, and visible outcomes. Follow the plan's full-suite rerun triggers, not just a convenient subset.
- `test:smoke:meta`, `test:smoke:anthropic`, and `test:smoke:openai-embedding` are separate credential-gated provider suites. A skip is not a pass; stand-ins, Graph acceptance, real inbound delivery, and recipient-visible replies prove different things. Record provider, topology, commands, outcomes, and limitations. Historical evidence is not a new run.
- Use existing authorized accounts/configuration and authenticated product setup paths. Inspect credentials without displaying values; never put secrets in logs, commits, prompts, or state files. Do not substitute synthetic traffic for required live acceptance.
- If required tools or external resources are unavailable, finish independent preparation/checks, record the exact missing dependency and user action, and keep required acceptance open. Follow the plan's distinction between required and supplementary browser verification.

## Finish and stop

1. Review all findings and Git status/diffs; record what actually changed, checks actually run, unresolved issues, and the exact next action. Distinguish task completion from phase completion.
2. Update `.agent/CURRENT.md` with phase, bounded objective, status, code baseline if useful, evidence pointers, next actions, blockers/user actions, and prohibited next action. Rewrite `.agent/HANDOFF.md` as the compact latest-session record: changes, findings, verification, commits, and continuation point. Keep both small; no transcript, growing journal, copied architecture, or secrets. Update `PLAN.md` acceptance records only with real new evidence; architectural changes require rule 11.
3. Make coherent local Conventional Commits when permitted. Review/show staged status and `git diff --cached` first, stage only this task, and run appropriate checks. Include state updates; cite existing hashes or identify the containing commit via Git rather than inventing its future hash. Recheck Git status after committing and report any remaining changes.
4. Apply every plan completion/tag gate before declaring a phase complete. Stop at the phase boundary; `continue` alone never authorizes starting the next phase. Never push, release, deploy, force-push, or rewrite shared history without applicable explicit authorization.
5. Stop only at a genuine boundary: a necessary architecture change, unresolved material product choice, unavailable secret/manual account action, destructive action requiring approval, or phase/release authorization. Explain the concrete reason and smallest user action. Do not interrupt for routine choices already governed by the plan.
