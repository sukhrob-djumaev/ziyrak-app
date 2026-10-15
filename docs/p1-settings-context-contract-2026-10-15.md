# P1 Settings permission and request context

Selected P1 §§6/8–10/14–16 owns this presentation correction. UI renders settings;
identity resolves current signed actor/selection; existing settings API owns permission,
scoped BusinessConfig and Default-Business-only legacy settings. No new service,
permission, raw-client UI import or dependency direction. P2 managed AI ownership,
provider/model/key migration and allowances remain outside this slice; existing AI
API behavior is historical and is not accepted as final managed-service behavior.

Exact applicable P1 criteria:

> Resolve selected workspace on the server; reject guessed IDs, privilege escalation,
> stale/revoked membership, expired support access and scope widening through API keys.

> Browser journeys must use each actual role, workspace selection and denied direct
> URLs/API calls.

> existing users retain legitimate access without gaining privilege.

Source findings: Settings is a client page. Denied initial reads currently render an
error-only view, but navigation is unconditional; rejected saves retain populated
forms and newly typed credentials. Requests follow mutable shared cookies without
rendered-workspace binding. Legacy read failures are ignored and can enable empty
legacy panels using an earlier profile flag. Independent investigation confirmed
source/interleavings, not executed browser outcomes.

Small correction: fresh server settings:read wrapper, context-lifetime key, rendered
workspace locator and canUpdate capability. Hide Settings navigation using the layout's
existing context. Preserve owner/admin including restricted-admin settings permissions;
do not copy workspace-wide team-delegation restriction. Every read/write binds the
rendered workspace header and existing server conflict guard. Known401/403 invalidates
pending work, clears all form/credential/configuration state, displays denial and
refreshes server context. Fresh responses only may change state; old/unmounted loads
and saves cannot repopulate credentials or success. Ordinary transient load errors
offer retry. Legacy panels appear only after their own successful current read.
Secret masking/storage and server APIs remain unchanged.

Tests first: actual isolatedPG/JWT/cookie SSR five-role/navigation, restricted-admin
positive, selected membership/session loss. Actual browser old-context save and
demotion must be checked before closure, with persisted wrong-workspace absence,
fresh current UI and no retained credential inputs. Preserve normal profile editing
and Default/nondefault legacy behavior. Relevant settings API isolation tests,
independent security review, type/strictlint, regression and fresh full browser suite
required; no provider calls needed for this UI/authentication boundary.

Work only in non-serving p1-support-identity/owly based893cb41. Separate frozen
runtimeafcab4e/buildOxGeKpu78acIcGaW740sU currently runs Administration full23; do not
edit its source/HEAD/deps/build/harness or share browser fixtures concurrently. Main
docs-only, paired isolated test databases. No deployment or new milestone. P1 open.

Independent source review also identified inherited legacy display-mask overwrite.
Actual synthetic UI/PG nonsecret edit confirmed two stored passwords overwritten
with masks before repair. Omit secret operands equal to fresh loaded/saved display
baselines (masked or empty), preserving explicit replacements/clears and later edits.
Actual browser/PG regression must prove preservation and updates without secret output.
No server/schema/provider contract change; this belongs to the same Settings boundary.
