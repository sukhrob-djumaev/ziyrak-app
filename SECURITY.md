# Security policy

Ziyrak is in launch preparation. No released-version support matrix, response SLA, external penetration-test certification or blanket production-safety claim is established by this repository. [PLAN](PLAN.md) and the [October 25 review](docs/project-review-2026-10-25.md) identify current scope, evidence and open findings.

## Reporting

Do not publish secrets, customer data or exploit details in public issues. The current project is [sukhrob-djumaev/ziyrak-app](https://github.com/sukhrob-djumaev/ziyrak-app), not the upstream Owly repository. Use GitHub private vulnerability reporting there **if enabled**, or an existing private owner contact. A verified owner-controlled private reporting channel and response owner must be established before public launch; no unverified email address or response-time promise is supplied here.

Include the affected commit/version, description, impact, sanitized reproduction and suggested fix if available. Coordinate disclosure privately. Do not test against other customers or production without authorization.

## Implemented controls and limits

The code includes authenticated sessions/password hashing, tenant-scoped data access, workspace/resource permissions, explicit platform support grants, encrypted stored credentials, signed Meta webhook verification, tool policies/approval, audit records and several rate-limit/input protections. These are controls to verify, not a guarantee that every input/log/endpoint has universal coverage. Platform authority does not implicitly grant tenant data access.

The current review's findings are tracked in launch tasks L1/L2; see [the review](docs/project-review-2026-10-25.md) for which are still open. No new exploit against production or actual secret disclosure was established by the review. The logger redacts sensitive keys and credential-shaped strings centrally (tested), which reduces but does not eliminate accidental disclosure; never assume logs are safe to publish. Webhook signatures require actual configured keys and receiver verification.

## Deployment requirements

Use independent high-entropy session/encryption keys, controlled backups and verified rotation/recovery. Configure HTTPS, origin/proxy trust and body/time limits for the actual edge. Keep databases/Redis private and pair migration/runtime DB targets deliberately. Use platform-managed AI credentials and each connection's own secrets. Account mail must use the intended verified sender; capture transport is isolated-test-only. Privileged account protection is a launch requirement.

Validate the complete web/worker configuration and shipped image, not only source tests or `npm audit --omit=dev`. Rehearse migrations, restore/rollback, queue recovery, alerts and incident handling. Current `/api/health` can return HTTP 200 on DB failure; it does not prove readiness. Docker/Helm/Compose have open findings and need rehearsal before public deployment. See [operator setup](docs/guides/operator-setup.md) and [release gates](docs/launch-roadmap-2026-10-25.md).

Patch dependencies through reviewed lockfile changes and boundary tests; do not blindly apply breaking audit fixes. Never point test cleanup at customer/acceptance databases, kill unrelated processes, or expose environment files. Report verification limits honestly: historical tests, stand-ins and a provider's API acceptance do not establish current recipient-visible delivery or production safety.
