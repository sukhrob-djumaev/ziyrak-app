# P3 accounts and customer onboarding: proposal for owner review (2026-10-22)

Status: PROPOSAL, no code. Governing text: PLAN P3 (scope, required behavior, verification, completion
criteria). P1 (access) and P2 (managed AI, so onboarding needs no AI key) are merged.

## 1. What exists today

- `User` has `username` + password, no email, no verification. Signup is open and atomic
  (`platform/provisioning.ts`), but the setup wizard asks for AI keys (obsolete after P2).
- Sessions are individually revocable by `jti` only; there is no "end all sessions of a user".
- No platform mail sender: only per-channel SMTP and `send_internal_email` (global SMTP, default
  workspace only). No invitation, reset or verification flow.

## 2. Proposed model

Control-plane tables (never tenant-writable):
- `User` gains `email` (nullable, unique when set, stored lowercased), `emailVerifiedAt`, and
  `sessionEpoch` (int). A session token carries the epoch; a mismatch ends it. Password reset and
  password change bump it, which revokes every existing session.
- `AccountToken`: id, userId (nullable for invites), purpose (`verify_email | reset_password |
  invitation`), tokenHash (SHA-256 of a 256-bit random secret; the secret is only ever in the emailed
  link), email bound at issue time, expiresAt, usedAt (single use, set atomically), payload (for
  invitations: businessId, role, scope, inviter, assignment ceiling), createdAt.
- `OnboardingState` per workspace: steps `knowledge`, `channel`, `test_reply`, `activation` each
  `pending|done|failed` with a sanitized failure reason; survives reloads and failures.
- `Business.status` gains `pending_activation`; activation is explicit and requires a verified owner
  email plus the required steps done.

Mail: a platform `MailTransport` interface with two adapters: SMTP (platform env config) and a local
capture adapter for tests/browser. No tenant data in templates beyond workspace name and inviter name.

Flows (all tokens expiring, single use, hashed at rest; every public endpoint rate limited per IP and
per address with identical responses for known and unknown accounts):
1. Signup: email required, creates workspace in `pending_activation`, sends verification. Repeat signup for
   the same email returns the same generic response and re-sends verification; never a second workspace.
2. Verify email: token consumes once, sets `emailVerifiedAt`.
3. Forgot/reset password: generic response; reset token (1 h) sets a new password, bumps `sessionEpoch`,
   marks the token used. Requires a verified email to be used.
4. Invitation: owner/admin invites an email with role and scope; they can only grant what they hold and
   never platform roles. Accept requires the signed-in (or newly created and verified) account whose
   verified email equals the invited address; an existing verified user joins with a second membership
   (no second identity). Cross-workspace and wrong-recipient attempts fail without revealing details.
5. Existing username accounts: no lockout. A signed-in prompt adds an email and sends a verification;
   until verified, the account keeps working in existing workspaces but cannot invite people or
   activate new workspaces. Adoption of an email that belongs to another account is refused.
6. Workspace admins manage Membership only, never another person's global email/password/identity.
   Last-owner rules are preserved.
7. Onboarding wizard (no AI keys): knowledge ready, channel set up, a real test reply through the managed
   AI path, then explicit activation. Failure of any required step blocks activation with a visible,
   non-technical reason and a retry.

## 3. Verification plan

Tests first: token replay/expiry/tampering, wrong recipient, cross-workspace, privilege delegation,
reset session revocation, enumeration resistance (identical responses and timing class), migration
adoption without takeover, last-owner, rate limits. Then browser journeys on a production web plus
separate worker with the capture adapter: signup, verify, invite, accept, reset, first useful reply, and
provider-failure resume. Independent security review. A controlled REAL mail delivery check is required
before claiming email delivery ready.

## 4. Decisions needed from the owner

1. **Mail transport and real delivery check:** platform SMTP configured by environment variables
   (host, port, user, password, from address), plus one real mailbox you control for the delivery
   check. Which SMTP service and sender address should I target, and will you put the credentials in
   the local `.env`?
2. **Token lifetimes:** verification 24 h, password reset 1 h, invitation 7 days. Agree?
3. **Existing accounts:** soft adoption (no lockout; unverified accounts cannot invite or activate new
   workspaces). Agree?
4. **Signup stays open** (any visitor can create a workspace, which stays inactive until the email is
   verified). Agree?
5. **Onboarding steps and gate:** knowledge ready, channel setup, successful test reply, explicit
   activation, as above. Agree?
