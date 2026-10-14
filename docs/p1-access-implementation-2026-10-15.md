# P1 implementation and criterion evidence

Status: first boundary slice implemented; P1 foundation/full acceptance open.
Authority: [explicit contract](p1-access-contract-2026-10-15.md) and PLAN P1.
Parent2adfc1b, isolated P1 checkout, own dependencies/no live environment copied.
Containing code commit is discoverable through Git, not predicted here.

## First slice

Workspace team update/remove guards deny generic ownership changes, API-key role
management and global account name/password changes. They validate all input before
membership writes, guard target role at mutation and return404 if a concurrent
promotion removes the authorized target. UI editing sends only the workspace role;
new secured account provisioning retains initial account fields.
Inbound resolves same-contact threads by connection identity, validates explicit
real-channel thread ownership/contact before preparation, and preserves authorized
internal API continuation through a tenant-scoped lookup. Unknown/foreign IDs404.

### Executed evidence

- Tests before changes: two new real-PG suites7failed/1passed against parent.
- Requested independent review regressions: actual-route API-key PUT/DELETE deny;
  cached target read followed by promotion cannot mutate/delete owner. The race
  error-mapping test initiallyfailed (500), then passed with controlled404.
- Focused five files21passed: team, connection ownership, internal chat, conflict,
  provider-signed phone/SMS pipeline with controlled provider/AI fixtures.
- Full134files1194passed/23 optional Redis skips; type and strict lint passed.
- Independent source/security review: no confirmed issue, including final late recheck.
  Reviewer did not run checks. No platform/restricted support workflow enabled.
- Existing phone test lacked creation's ownership stamp; corrected fixture to
  reference its actual test connection. No insecure legacy inference introduced.

### Open verification

Production build and full browser rerun for this slice pending. Provider fixtures
prove local routing/persistence, not real recipient delivery. R4 retains affected
provider checks. No P1 criterion closed on these counts; foundation, every exposed
resource path, mandatory support audit/lifecycle, actual roles/UI and full browser
acceptance remain required. No live bootstrap/migration or deployment.
