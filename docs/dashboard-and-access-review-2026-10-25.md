# Dashboard, access and usability review — 2026-10-25

Source review at `3066b33`, with independent AI-agent investigation. No browser/user study was run for this document. Findings are current source observations; recommendations are LP-2026-10-25 requirements, not implemented screens or measured usability results.

## Current surface and defects

The product has inbox/conversations, customers, tickets, knowledge/test, canned responses, automation, hours, approvals/tool policies, SLA, channels, webhooks, roster/departments, account administration/API keys, settings, analytics and activity. Platform enrollment/operators/support/AI service are separate. There is no subscription UI, commercial catalog or billing console. Sidebar has 18 dashboard links plus workspace switch.

| ID | Source-confirmed issue | Required correction |
| --- | --- | --- |
| D01 | `src/components/layout/sidebar.tsx` filters only Administration, Settings and Approvals. Lower roles see Channels/Webhooks/Activity their APIs reject; viewers see Canned Responses without its read permission. Team/Channels show writes to read-only roles. | Derive visible navigation and actions from current server permissions; keep API/service checks authoritative. Explicit denial for direct URLs, readable read-only state, no false success. This finding is UX inconsistency, not proof of authorization bypass. |
| D02 | `header.tsx` sends every role's Profile & Settings link to admin-only `/settings`. | Separate personal account/security/session controls from workspace administration; workspace switch has obvious current context. |
| D03 | Header search opens an input without search; bell has a static unread dot and no action. | Remove inert controls for launch or implement and verify their scope/results/notification behavior before showing them. |
| D04 | `/team` edits `TeamMember` roster labels member/lead/manager/admin; `/admin` edits real Membership roles owner/admin/supervisor/agent/viewer. TeamMember has no login membership relation. | Group People & access, clearly distinguish accounts/invitations/permissions from assignment roster/departments. Adding a roster member must not imply account creation. Do not silently merge models. |
| D05 | Webhook save ignores HTTP status, closes form on rejection and silently catches network failures (`webhooks/page.tsx`); Team has similar failed-response paths. | Check success, retain entered values, show field/general errors and retry guidance. Audit all active CRUD forms for 401/403/409/5xx and network failures. |
| D06 | Legacy onboarding asks `/api/settings/ai` whether workspace is managed; lower roles lack settings access, so denial can show obsolete customer-key instructions. Dismissal is browser-wide. | Explicit role/workspace onboarding state; no inference from forbidden settings API. Scope dismissals correctly. New panel must distinguish failed loading from no work, and owner-only actions from member guidance. |
| D07 | New onboarding counts active connections and tests AI through an `api` conversation (`src/lib/onboarding/service.ts`); this does not prove actual widget/Meta delivery or billing. | Separate assistant test, channel delivery, commercial provisioning and activation states. Resume after interruption. Explain third-party setup prerequisites before purchase. |
| D08 | Email/Phone cards always appear; generic connection test/connect checks config then marks success (`connections-service.ts`). Generic one-card-per-type UX does not prove multiple billable connections. | Explicit release capability matrix. Hide/label deferred channels; no paid quantities before actual quantity support and delivery acceptance. Meta and Web Chat remain priorities; QR is demo-only. |
| D09 | F13 response metric expects message role `user`, while inbound records use `customer`. F14 Keyword Alert is offered but deliberately skipped in execution. | Correct metric fixtures/implementation; disable/explain unsupported alert. Do not advertise output that does not occur. |
| D10 | `scripts/acceptance/j13-approval.cjs` sets policy via SQL and approves/rejects via API, with a stale “no UI exists” comment. J01 also uses controlled legacy-BYOK setup after signup for older journeys. | Reconcile harness with current UI requirements during L3; keep API denial tests but add actual approval/policy UI steps. Use J27/J28/J30 for managed-flow evidence; do not label all historical scripts as one unmodified managed journey. |
| D11 | `src/app/api/openapi.json/route.ts:6–14` retains upstream contact and broad Email/Phone claims. The API schema is manually maintained. | Reconcile served API documentation with supported routes/authentication and the release matrix during L3; do not present it as independently verified exhaustive coverage. |

Source paths are under `src/app/(dashboard)/` unless otherwise named. The earlier F findings are retained in the [project review](project-review-2026-10-25.md). New D findings have these baseline pointers:

- D01: `src/components/layout/sidebar.tsx:165–169`; `team/page.tsx:623–635`; `src/app/api/team/departments/route.ts:25–27`; `src/lib/rbac/rbac.ts:27–138`.
- D02/D03: `src/components/layout/header.tsx:95–127,151–159` and workspace `settings/page.tsx`.
- D04: `team/page.tsx:254–265`; `prisma/schema.prisma:70–84,570–590`.
- D05: `webhooks/page.tsx:124–141`; `team/page.tsx:410–435,457–465`.
- D06: `src/components/ui/onboarding-checklist.tsx:44–63,93–98,134–148`; `src/app/api/settings/ai/route.ts:70–72`.
- D07: `src/lib/onboarding/service.ts:38–53,71–76,91–95,109–117`; `src/components/ui/onboarding-panel.tsx:31–37,61,105–125`.
- D08: `channels/page.tsx:911–935`; `src/lib/channels/connections-service.ts:18–22,44–55,184–193`.

 Before implementation, recheck against the selected commit; line numbers and UI grouping can change.

## Target information architecture

| Area | Contents and rationale |
| --- | --- |
| Home / Get started | Role-specific next action, onboarding progress, service/usage notices; no duplicated setup checklists. |
| Inbox | Conversations, assignment/handoff, approvals and delivery recovery where permitted. |
| Customers and Tickets | Customer context and ticket work; retain as work areas while validating how target customers use them. |
| Knowledge | Knowledge entries, assistant testing and reusable replies. |
| Assistant | Behavior, automation and working hours; advanced SLA/tool settings subordinate to the task. |
| Connections | Supported channel setup; advanced integrations group webhooks, API credentials/docs. |
| People & access | Login accounts, invitations and permissions; distinctly labelled roster/departments. |
| Reports | Analytics and authorized activity/audit views. |
| Usage & Billing | Service limits/status; owner-only plan/add-ons, payment methods, invoices and cancellation. Other roles receive only the service information their work needs. |
| Workspace settings | Business preferences. Personal profile/security and workspace switch belong in account/context controls. |
| Platform console | Separate AI service, operator/support administration and future catalog/commercial operations; tenant support remains explicit and audited. |

This is a grouping proposal to validate with journeys, not a requirement to replace working pages or add many new screens. Keep navigation shorter by nesting advanced work. Remove placeholders and unsupported promises before adding cosmetic dashboards. Distinguish **role denied**, **not included**, **limit reached**, **setup required** and **service unavailable**; each needs a relevant explanation/action. A nonowner should not be invited into a purchase they cannot authorize.

## Role and commercial access

The current exact permission matrix is `src/lib/rbac/rbac.ts`; resource/channel scope further constrains it. The table below summarizes responsibility, not a replacement for individual API permissions.

| Actor | Responsibility | Billing/access boundary |
| --- | --- | --- |
| Viewer | Permitted read views | No writes/purchases; not every screen is readable. |
| Agent | Conversation/message/ticket/customer work within scope | No workspace administration or purchasing. |
| Supervisor | Operational oversight, assignments/approvals and allowed exports/configuration | Read capability does not imply configuration writes or billing. |
| Workspace admin | Permitted settings, channels, team/access administration | No implicit ownership transfer, deletion or payment authority. |
| Workspace owner | Workspace administration and ownership duties | Existing owner-only `business:billing` anchors future commercial management; no billing flow exists yet. |
| Platform operator | Explicit assigned support operations through current grants | No implicit customer membership, price/refund rights, global secrets or self-assignment. |
| Platform super-admin | Platform policy/operators and future catalog | Customer-data access still uses explicit support mechanisms; commercial powers need separate audited operations. |

Every paid feature requires identity, permission/resource scope, entitlement and operational availability. Subscription changes do not modify roles. Financial records need their own scoped authorization. Security/recovery, isolation and billing remediation cannot be disabled as paid add-ons. Refer to the [billing contract](billing-and-entitlements-spec.md) for enforcement and delayed-work requirements.

## Acceptance and usability work

L3 must run owner/admin/supervisor/agent/viewer browser journeys, invitation/workspace switching, role/scope downgrade and revoked support; check direct URL/API denial as well as hidden controls. Verify form failures preserve input and do not claim success. Revisit each active screen for meaningful empty/loading/error/success states, accessible names, keyboard navigation/focus, contrast, narrow/mobile layout, dates/timezones and destructive-change confirmation.

L5/L6 add new signup → verify → package → checkout → provision → configure → actual supported-channel reply → handoff, including interrupted/resumed setup, decline/recovery, feature removal and renewal. Measure task completion and points of confusion with intended users; do not equate code review or automated accessibility checks with a user study or full compliance certification. Record findings and fix blockers before broad paid rollout.
