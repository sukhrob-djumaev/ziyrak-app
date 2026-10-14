# P1 secured platform enrollment and recovery

PLAN P1/§§7–9,12,14–16 and the explicit platform/support contract govern.
Platform owns authority and mandatory audits; identity supplies signed person
sessions; tenant memberships/resource repositories receive no implicit bypass.
This slice implements bootstrap/recovery only. Operator provisioning, assignments,
support activation and delayed authority remain unfinished P1 work.

## Operational contract

The signed-in person opens `/platform/enrollment`, selects their displayed current
account, supplies an administrative reason and the appropriate owner-held proof.
Enrollment and recovery use separate server-only configuration:
`PLATFORM_BOOTSTRAP_PROOF_SHA256` and `PLATFORM_RECOVERY_PROOF_SHA256`, each the
64-character SHA-256 hex digest of a separately generated high-entropy proof.
Empty/malformed configuration denies the corresponding action. Raw proofs are not
stored by the server, returned, audited or persisted by the page; the masked input
is cleared after each attempt. Configure them through the deployment's existing
secret-management path, never browser-public variables. No live configuration or
production enrollment was performed by this session.

Public signup and the historical display flag confer no platform authority.
The service verifies signed expiring, revocable sessions and exact self-selection.
Privileged writes share a short Postgres transaction/advisory lock and recheck
session revocation/current account after acquiring it. Control pointer and current
super-admin role must agree before ordinary platform authority is admitted.
Enrollment succeeds once. Recovery requires the separate proof and the displayed
expected generation; stale generations conflict. Recovery repairs pointer/role
drift, demotes displaced super roles, revokes displaced grants and advances the
generation atomically. Mandatory audit failure rolls back all mutations. Existing
ordinary memberships are preserved; no owner membership is fabricated.

The API requires a person session, denies API keys, requires same-origin JSON
writes and enforces five attempts/minute per authenticated account regardless of
forwarded address. Bodies are strict; unknown actions/role fields deny. Self entry
metadata contains only account display/id, effective platform role, generation and
action availability. It exposes neither tenant data nor proof/session material.

## Verification

Tests preceded service implementation (missing-contract failure), then 13realPG
cases passed: missing/wrong/malformed/separate proof, explicit account selection,
legacy flag/non-revocable/forged/revoked sessions, strict body, concurrent bootstrap
and recovery, stale generation, pointer/role drift repair, audit rollback, displaced
grant retirement, and an old privileged write queued inside actual recovery.
Three API cases failed against the absent route, then passed after integration.
Independent route review found actor/IP-pair rate-budget evasion. A sixth-attempt
regression reproduced it (403 instead of429); actor-only limiting fixed it. Final
focused17platform cases plus86route-coverage cases passed; type/strict lint passed.
Independent source/security rechecks found no remaining confirmed issue in this
bounded integration; reviewers did not independently execute checks.

Logs `/private/tmp/ziyrak-p1-platform-authority-{red,green2,green3}.log`,
`/private/tmp/ziyrak-p1-platform-route-{red,green}.log`,
`/private/tmp/ziyrak-p1-platform-rate-{red,green}.log`.
Module-only full1296/23optional and signup789 passed before API integration.
Final frozen-source full144files1301passed/23optional skips; signup75files794passed;
type/strict lint passed. Logs `/private/tmp/ziyrak-p1-enrollment-full-final.log`,
`/private/tmp/ziyrak-p1-enrollment-signup.log`, type/lint logs with same prefix.
Production full20browser acceptance is pending at this checkpoint; prior
widget-only browser evidence cannot close this workflow. Candidate build
oNIe1NB_lH9Q5DEg-o0VY, runtime parent d026791 plus frozen product digest
5607ad247b9ef70ebeed27c51f081e56a16b21a5f18c1e49340246bb8d4dbb61.
Development product digest exactly matches the frozen runtime candidate. New J20 exercises actual denied proof/enrollment/recovery/UI role
refresh and persisted audit using synthetic local owner proofs, never live accounts.
