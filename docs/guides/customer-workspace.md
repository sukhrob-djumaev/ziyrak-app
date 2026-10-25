# Current customer workspace guide

Checked against source on 2026-10-25. This describes implemented behavior; it is not production release acceptance. See the [launch roadmap](../launch-roadmap-2026-10-25.md) for remaining work and the [dashboard review](../dashboard-and-access-review-2026-10-25.md) for known usability gaps.

## Account and setup

Public signup has three steps: **Create Your Account → Business Profile → Check Your Email**. Account, private workspace and owner membership are created together when the business profile is submitted. Public signup does not create a platform administrator. Passwords require at least eight characters; the server also rejects passwords over bcrypt's 72-byte UTF-8 limit. Verify email before activation. Existing users can accept invitations and switch between workspaces they are authorized to access. Verification, reset and invitation delivery depend on platform transactional mail being configured.

Managed workspaces receive platform-controlled AI service and usage limits. Customers supply business knowledge and supported-channel configuration, not AI API keys/raw model choices. Legacy BYOK compatibility is not the new-customer setup path. Only authorized platform administrators configure managed provider policy/credentials.

Current onboarding tracks knowledge, channel, assistant test and activation. The assistant test is not an actual channel-delivery test; the launch plan requires that additional proof. A workspace's current active connection status does not by itself establish provider readiness. Known role/loading/legacy-checklist inconsistencies are tracked as D06/D07, not instructions to grant wider permissions.

## Working areas and permissions

Use conversations for messages/handoff, customers for customer context, tickets for follow-up work, knowledge and reusable replies for answers, and approvals for permitted review of AI tool requests. Supervisors/admins/owners can review actions; admins/owners can change tool policies. Operational configuration also includes hours, automation and SLA. Keyword Alert is currently incomplete and must not be relied on for delivered notifications.

The current sidebar is broader than some roles can use. API checks remain authoritative; an access-denied response is not a reason to share an owner login. Workspace roles are owner, admin, supervisor, agent and viewer with channel/resource restrictions. Platform operator/super-admin authority is separate and does not silently grant customer-data access. [Access review](../dashboard-and-access-review-2026-10-25.md) contains the summary; `src/lib/rbac/rbac.ts` defines exact permissions.

Administration manages actual login users/invitations/access and API keys. Team manages an assignment roster/departments; adding a roster entry does not create an authenticated account. Settings is workspace administration, despite the current header's misleading Profile & Settings label.

## Reviewing AI actions

Authorized reviewers open Approvals, select Waiting and inspect the action/details before choosing Approve or Reject and confirming. Approval can execute an action that changes data or sends a message. Check the reported result and History; approval can fail during execution, and another reviewer may already have handled the request. A rejected action does not run.

The Policies tab exposes Available, AI may use it, Needs human approval and the roles allowed to run the tool manually. Admins/owners manage these controls; supervisors can read policies and review actions. A permission to approve is not a reason to bypass inspection. Current UI behavior is source-checked; the old J13 script still needs to exercise these real controls instead of substituting API/SQL calls.

## Channels and payments

Web Chat and Meta WhatsApp Cloud are the production-path priorities, subject to release verification. Meta uses each connection's encrypted credentials and App Secret plus the platform verification token. Third-party number/app setup can require customer/provider steps. WhatsApp Web QR is a gated development/demo option. Email and Phone UI entries do not establish production delivery support; do not sell or depend on them as accepted channels.

Subscriptions, checkout, payment methods and configurable add-on sales are **not implemented**. Existing usage allowances are service controls, not invoices. The [billing contract](../billing-and-entitlements-spec.md) defines the target. Current source should not be advertised as a ready paid self-service product until the [launch gates](../launch-roadmap-2026-10-25.md) pass.
