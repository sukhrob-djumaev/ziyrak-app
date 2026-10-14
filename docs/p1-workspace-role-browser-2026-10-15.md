# P1 supplementary workspace-role browser matrix

Status: passed, executed sequentially after uninterrupted full20/J20 released both
owner profiles. Product candidate17f0707 corresponds
to frozen runtime parentd026791 + digest5607ad247b9ef70ebeed27c51f081e56a16b21a5f18c1e49340246bb8d4dbb61,
buildoNIe1NB_lH9Q5DEg-o0VY. No product/dependency/build changes for this journey.

`scripts/acceptance/j21-workspace-role-matrix.cjs` uses the actual workspace owner
Administration UI to create fresh admin/supervisor/agent/viewer accounts, verifies
their saved full-workspace membership and absent platform role, then signs in each
through the real login page. Random fixture passwords remain in memory. Owner is
the original real signup fixture. This is secured workspace account provisioning,
not P3 invitation lifecycle or platform operator provisioning evidence.

Observed checks (every positive item returned the exact persisted ID):

| Actual role | Own known conversation | User list | Business settings | Approval read | Owner demotion | Foreign known conversation |
| --- | --- | --- | --- | --- | --- | --- |
| owner | 200, exact ID | 200 | 200 | 200 | 403 | 404 |
| admin | 200, exact ID | 200 | 200 | 200 | 403 | 404 |
| supervisor | 200, exact ID | 403 | 403 | 200 | 403 | 404 |
| agent | 200, exact ID | 403 | 403 | 403 | 403 | 404 |
| viewer | 200, exact ID | 403 | 403 | 403 | 403 | 404 |

Real Administration table must contain the owner row only for owner/admin; denied
roles must have zero table rows. The existing direct page shell remains reachable;
data/API denial is distinct from an HTTP403 document gate. Record that UI limitation
without falsely claiming the document itself denied. Approval cases check reads,
not action approval/execution permission. Screenshots and page exceptions recorded.

Additional actual-boundary checks: anonymous enrollment page redirects to login and
API401; cookie-only enrollment GET200 paired with API-key+cookie403; recovered B
super admin still cannot read a persisted A conversation outside its ordinary B
membership (404). This proves no implicit tenant data grant, not support activation.

Independent source-only harness review caught an incorrect legacy `/api/settings`
expectation before execution; changed to current workspace `/api/settings/business`.
It also prompted exact-object positive read, table-row and cookie-only controls.
No execution or acceptance claim comes from source review. Restricted-connection
UI, platform operators/assignments/support and delayed authority remain unfinished
P1 criteria even if this full-workspace role matrix passes.

Execution log `/private/tmp/ziyrak-p1-workspace-role-browser.log`; artifacts under
runtime `scripts/acceptance/.work/p1-enrollment-20261015`, including five role
screenshots. No browser runtime exceptions. Viewer screenshot inspected: empty
Administration shell still offers Add User/API Keys/Settings navigation; server
reads/actions deny and no protected table rows render. Permission presentation/
access-denied UI remains open P1 work, not a claimed403 document gate. Product
source digest stayed unchanged. Own topology stopped with remainingOwned[].
