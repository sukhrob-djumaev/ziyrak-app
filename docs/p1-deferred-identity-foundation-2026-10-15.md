# P1 deferred identity foundation

Implementation on4e38f9a; containing commit identifies source. Internal helper only:
no queue producer, worker, TenantContext, provider-origin or dispatch integration.

## Contract and exact acceptance

Tenancy owns strict versioned identity ceiling capture/refresh, consuming platform's
narrow control-plane identity reader. The reader owns Business/Membership/ApiKey
facts; no provider SDK or reverse infrastructure→domain dependency is introduced.
Returned role/scope are fresh facts, not an operation authorization or reusable
human/support grant. The actual consumer must enforce tool/admission policy,
action/resource/lifecycle binding and fresh dispatch/retry checks.

> Recheck revocation for long-lived subscriptions and delayed user-initiated work;
> system jobs retain only their defined operation, not a reusable human support grant.

This foundation supports that P1 criterion; the unwired helper does not close it.
Owner explicitly selected recorded schedules surviving logout/session expiry, while
exact membership/key validity and permissions are rechecked before sending.

## Implemented

- Strict v1 snapshot has business ID, exact membership/user or API-key reference,
  and saved resource ceiling. Extra/unknown fields/versions/scopes deny. No bearer,
  copied role, session lifetime, credentials or placement secret is persisted.
- Human/key provenance survives an AI actor retag. Missing/support/delegated origins
  and mismatched human/key actors deny; system/channel actors cannot manufacture
  human origin. An origin failure never falls back to autonomous provider authority.
- Shared control-plane reader re-reads active workspace, exact membership identity
  and current known role/scope, or exact live unexpired/unrevoked key with bounded
  role/classification/current issuer authority. Issuer-based keys pin both issuing
  person and membership ID; membership removal/recreation/substitution cannot revive
  a saved key. Explicit legacy_workspace/null-issuer classification is supported;
  unclassified or changed classifications deny rather than being guessed.
- Current scope/profile capability intersects the saved ceiling. Current role is
  returned for the later operation-policy check; demotion is observed, not silently
  accepted as permission. Missing/deleted connections and exact target ownership
  still require the later lifecycle/destination validator. Empty facts confer no
  resource access. No TenantContext is constructed or placement assumed.

## Verification

Seven tests were added before implementation and failed at the missing new module;
no behavioral assertions ran. Initial implementation passed6; one fixture incorrectly
used a nested composite-FK create, fixed to explicit owned control-plane fixture
creation. Then7passed. Reviewer-requested key AI/mismatch/issuer substitution/
classification, invalid role/scope and profile-shrink/capture-narrowing cases were
added:9cases passed with real Redis selected. Full145files/1358passed/23optional
skips; signup-seeded76files/840passed; type and strict lint passed. All databases
isolated from acceptance and live user data with both connection URLs pinned.
Independent source-only security review found no confirmed material issue in this
foundation; reviewer did not execute checks.

Logs: /private/tmp/ziyrak-p1-deferred-origin-{red,focused,focused2,
final-focused-redis,type2,lint,full,signup}.log.
The current grant-console browser build56bed6c excludes this newer helper. No
browser acceptance of this helper, queue revocation, real provider, migration,
deployment or P1 completion is claimed. No product workflow is exposed by the helper.

Next: explicitly validate provider receipt→inbound operation→conversation→connection,
persist immutable exact action/operation/resource snapshots before enqueue, capture
real approver separately, and refresh fixed operation authority before every actual
adapter submission/retry. Unknown legacy work fails closed; no live cutover performed.
