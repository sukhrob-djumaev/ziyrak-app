# P3 accounts and customer onboarding: implementation record (2026-10-22)

Design and decisions: `docs/p3-accounts-onboarding-proposal-2026-10-22.md` (approved by the owner 2026-10-22).
Status: implemented on branch `p3-onboarding`; verified below. Not merged, not deployed. The controlled
real-mail delivery check is NOT done (needs sender credentials), so email delivery is not claimed ready.

## Behavior

- **Signup** (`POST /api/auth`, action `signup`) requires an email, creates the workspace and owner account,
  and signs nobody in. The answer (202) is identical whether the address is new, claimed unverified, or already
  verified by another account; a taken username is reported first (409) so the address never changes the answer.
  A verified holder gets a warning mail instead. Mail per address is budgeted (3/hour) and sent after the response.
- **Tokens** (`src/lib/identity/account-tokens.ts`): 256-bit random, SHA-256 at rest, single use by one conditional
  update, bound to purpose and recipient, expiring (verify 24 h, reset 1 h, invitation 7 d). A wrong-purpose or
  wrong-recipient attempt does not burn the token; a newer token of the same purpose/recipient/account replaces older.
- **Email identity:** `User.email` + `emailVerifiedAt`; a verified address is unique through a partial unique index
  (unverified claims may coexist until one proves the mailbox). Existing username accounts keep working with no email
  and adopt one through `/api/auth/email` (current password required; nothing is stored until the link sent to the NEW
  address is used; the old verified address stays until then).
- **Recovery:** forgot-password answers identically for any input; a reset needs a verified, non-platform account; the
  new password ends every earlier session (`User.sessionsValidAfter` vs the JWT `iat`, cutoff = next whole second).
  Per client+address (3/h) and per address (10/h) budgets. Platform accounts keep the audited recovery process.
- **Invitations** replace admin-chosen passwords (`POST /api/admin/users` now invites). Bound to recipient, workspace,
  role and scope; inviter needs a verified email, workspace-wide human authority, and cannot grant ownership, a platform
  role, or more customer-profile access than they hold; budgets 50/h per workspace and 3/day per recipient; one open
  invitation per address and workspace. Acceptance re-checks the inviter inside the transaction; an existing verified
  account must be signed in as itself (no second identity); a new person chooses their own username and password and
  their address is verified by possessing the link; platform accounts never join. Workspace admins still cannot change
  another person's name, password or email.
- **Onboarding** (`OnboardingState`): knowledge and channel readiness are read live; the test reply result and
  activation are stored, so state survives reloads and failures. The test reply asks the real assistant a question from
  the workspace's own knowledge through the managed AI path and records pass/fail with a readable reason (never provider
  text). Activation needs the owner, a verified email and every step done. Until activation, visitors get a neutral
  notice and no AI work happens (inbound gate); managed AI starts `pending_verification` and is released by the owner's
  email confirmation (an operator suspension is never lifted).
- **UI:** email-first signup wizard (no AI step), verify / forgot / reset / accept-invitation pages, dashboard onboarding
  panel, account email banner, invitation list and Invite dialog in Administration.

## Known limits and residual risks (accepted or open)

- Platform mail is captured to a file in tests and browser journeys; real delivery is a separate manual check (open).
- Operator invitations are NOT built: super admins still provision operators with a chosen password (P1 flow). Open item
  for the owner.
- A timing difference remains between known and unknown forgot-password addresses (one token insert, rate limited).
- Sessions already open as server-sent streams are checked at connect, not on each event.
- The onboarding test conversation appears in the conversation list as an escalated "Onboarding test".
- `TRUSTED_PROXY_HOPS` must be set in production for the per-address limits to hold (existing documented requirement).

## Verification record

- Unit/real-PG: 176 files, 1748 passed, 23 skipped (Redis-gated) on an isolated database; tsc and lint clean. The one
  failure in some runs is the existing `delivery-worker-restart` test, which passes alone on a fresh database.
- Independent read-only agent security review: no takeover path; confirmed gaps fixed tests-first (signup username
  oracle, unbudgeted warning/invitation mail, forgot-password budget burn, same-second session cutoff, inviter recheck in
  the acceptance transaction, operator console allowing the pending status). Agent review, not human.
- Browser: candidate `01d9b59`, fresh DB `ziyrak_acceptance_p3_20261022f`, headless system Chrome, Redis 6381, stand-in
  AI provider, platform mail captured to a file. All 28 journeys passed in one run, including J01 (signup, mail,
  confirmation, sign-in), J23-J26 (administration through invitations), J27 (managed AI) and the new J28 (inactive until
  activated, provider failure and resume, reset ends sessions, invitation through the UI, wrong recipient refused,
  existing account adopts a verified email). Screenshots inspected: onboarding start/failed/activated and the legacy
  banner. Earlier attempts on previous builds failed for journey-script and one real regression (restricted
  administrators requested invitations and the page treated the 403 as lost authority; fixed) and are not counted.
- Not covered: real mail delivery, windowed-browser mode, real provider through the browser, human review.
