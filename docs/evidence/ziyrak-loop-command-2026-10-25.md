# Local Ziyrak loop command correction — 2026-10-25

The owner asked to loop the existing local `/ziyrak` command. Inspection found the prior preparation had set
`disable-model-invocation: true`, which prevents scheduled skill execution under the documented Claude loop behavior.
Changed it to false, added `run` as an alias of `continue`/`start`, and documented self-paced and fixed-interval forms.

The skill must not create schedules unless requested, duplicate an existing loop or expand the approved scope.
It checkpoints and stops its own loop at STOP/completion or a blocker with no independent eligible work.

Checked frontmatter, aliases, scope/STOP text, local references and `git diff --check`. No application tests or
model-driven loop were run: this changes skill configuration/instructions only. Installed Claude reports 2.1.310.
Current provider behavior was checked against [official scheduling documentation](https://code.claude.com/docs/en/scheduled-tasks).

An existing uncommitted CURRENT change records an active L1.1 worktree. That state and the active task's code were
left untouched; this correction belongs to the coordinator checkout's command and guide. No push/deploy occurred.
