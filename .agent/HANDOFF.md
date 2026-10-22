# Latest session (2026-10-22, P3)

Built P3 on branch `p3-onboarding`: hashed single-use account tokens, email-first signup that signs nobody in, verified
email, non-enumerating reset that ends sessions, self-service email adoption, recipient-bound invitations replacing
admin-set passwords, resumable onboarding with a recorded test reply and explicit activation, inactive-workspace gate,
UI and journeys. Merged main (token diet, P2 completion) into the branch.
Verified: unit 1748/23 skipped, independent agent security review fixed, fresh-DB full browser 28/28 on 01d9b59 (stand-in
AI, captured mail). Owner decisions: operator invitations deferred; real-mail check not run (no delivery claim).
Continuation: owner merge approval for `p3-onboarding`. Details: docs/p3-accounts-onboarding-implementation-2026-10-22.md.
