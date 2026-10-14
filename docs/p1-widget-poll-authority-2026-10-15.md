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

Code c56686d705f8fde7eaf1bcb667d205435fa40239, runtime equivalent
 d02679199fa6102e3705efb6180370890fda32be. Fresh migrated isolated
`ziyrak_acceptance_p1_poll_20261015`, own Redis6381, production web/separate
worker/local LLM stand-in/real Chromium: uninterrupted `run-all.sh` full19journeys
passed. Build9146d4aHpG45JEXRsbL8K, digest
b7569e24a080566e2ec239b56d8718481c93cb70f8efbc3216eafee371bf29e7.
Artifacts runtime `scripts/acceptance/.work/p1-poll-20261015`, log
`/private/tmp/ziyrak-p1-poll-browser.log`. Own topology stopped; exact saved/current
PID/birth/cwd comparison found remainingOwned[]. No real-provider claim.
No main product/live account/provider/runtime changes.
P1 platform/support/delayed authority and complete role acceptance remain open.
