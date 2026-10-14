# P1 widget polling follow-up

PLAN P1 public channel and retirement boundaries; isolated development only.
Initial stream/poll checks now require actual webchat channel and live parent.
Poll content and cursor queries repeat current business/channel/visitor/connection
ownership and retirement predicates. Cursor lookup admits customer/assistant only.

Tests first on real isolated `ziyrak_p1_test_20261015`: initial inconsistent legacy
rows reproduced three failures (stream retirement already denied); controlled
parent-read → retirement → content-read and internal cursor reproduced two more.
Final focused three security files58passed; full143files1283passed,23optional skips;
TypeScript and strict lint passed. Independent read-only security recheck found
no remaining confirmed issue in this targeted follow-up; reviewer ran no checks.
Logs `/private/tmp/ziyrak-p1-widget-initial-read-red.log`,
`/private/tmp/ziyrak-p1-widget-poll-race-{red,green}.log`,
`/private/tmp/ziyrak-p1-widget-poll-{full,type,lint}.log`.

Containing commit is established by Git. Fresh production build/full19journey
rerun is still pending for this follow-up; prior stream browser evidence does not
cover these new edits. No main product/live account/provider/runtime changes.
P1 platform/support/delayed authority and complete role acceptance remain open.
