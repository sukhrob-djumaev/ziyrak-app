# P1 Administration permission presentation

## Implementation and contract

Contract p1-administration-ui-contract-2026-10-15.md, PLAN P1 §§8/9/15/16.
Code identity is the containing local commit, based onc199376. Isolated development
checkout p1-support-identity/owly excludes the incomplete follow-up integration.

Server /admin resolves fresh selected cookie/session/membership and requires existing
admin:read before mounting its client. Missing context redirects to workspace entry;
other denied roles see explicit denial without protected list requests or controls.
Dashboard layout passes already-resolved administration permission to sidebar; no new
permission endpoint or support SSR activation. No backend permission changes.

Client receives booleans derived from existing service/API contracts: user management
requires workspace-wide human authority plus its mutation permissions; owner rows
have no generic edit/delete. Keys preserve separately allowed scoped-admin capability,
including current PUT using admin:read. Key list uses actual safe keyPrefix/lastUsedAt
fields; generated secret stays only in its one-time dialog, never persistence/logs.

Opaque server context key covers workspace/actor/role/placement/current provenance/
normalized scope. A refreshed context replaces client rows, forms, credentials and
key state. Each resource's newer GET supersedes its older controller. Global denial
and unmount invalidate all generations. Freshness checked after JSON and again at
state commit.401/403 clears protected rows/dialogs/password/generated key and refreshes
server context. Nested API errors become text. UI booleans never authorize an API.

Support list screenshot review found cramped table headers in the narrow console.
This candidate adds column padding/minimum width and a keyboard-focusable horizontal
scroll region. Its new screenshot verification remains open.

## Executed evidence

- Tests first:12actualPG/JWT/cookie-resolver SSR rendering cases initially9desired
  failures/3positive controls. Denied supervisor/agent/viewer, revoked session or
  removed membership still rendered old controls; restricted admin wider delegation
  and navigation also failed. Fixed-role/nav behavior passed. Missing-context cases
  now explicitly assert the existing redirect (first post-fix run10pass/2redirect
  expectation mismatches, corrected assertion; no redirect defect claimed).
- Focused presentation12 + workspace team API8:20passed. After final display-field
  correction, presentation/team/admin isolation/admin users4files32passed. Type/strictlint
  passed after lifecycle cleanup correction; original lint found one ref-cleanup
  warning, repaired with captured lifecycle object.
- Independent security source review found retained state after context refresh and
  overlapping reads accepting older snapshots. Both reproduced by actual Chrome/
  realPG probe BEFORE repair, using dedicated port3200/database. Red build
  aqBOPHPU4GtUfQK_wiY-9/digesta936818edc9b444ebb477b6bb9dbd94f30fa8d9b559d70f7287bc1c75b675568:
  narrow scope + controlled real Next Link RSC refresh left dialog/password visible;
  held actual initial usersGET200 released after UI create201/newerGET erased new row.
- After context key/GET supersession, green probe exit0 on buildOrtEvEP8tGOSLwlSDn5z5/
  digest73fdb80bcb5523fef0dc4c3530638d6e07b1b984c1ce1682421d5a5db275dfc9:
  dialog/password absent, permitted key tab retained, newer user row retained and
  no browser runtime exceptions. The supplementary users-read green used700ms after
  release; robust settlement/cancellation check is required in J23 before acceptance.
  Exact owned probe server/browser stopped and absent verified. DB/profiles retained.
- Full149files1464passed/1Redis-mode skip, exit0. This full run includes the context/
  read-order fixes and table layout; it precedes the subsequent safe-prefix/time
  display field correction. Signup-seeded80files924passed/exit0. Type/strictlint after the display-field
  correction passed. Final field behavior still requires its new browser checks.
- Independent final security source recheck clear after both confirmed fixes.
  Independent J21/J23 harness review corrected profile-ceiling, request settlement,
  navigation timing and exact one-time-display evidence gaps. Final source recheck
  clear. Reviewers ran no tests/browser; execution above is lead-owned.

UI probe setup: separate fresh ziyrak_acceptance_p1_admin_ui_probe_20261015, paired
URLs/private env /private/tmp/ziyrak-p1-admin-ui-probe.env, actual signup/provision/login
APIs/UI, synthetic accounts. Scope narrowing is controlled fixture state and same-route
RSC Link refresh is a controlled trigger, not a natural pointer gesture through an
overlay. No worker/provider/delivery claim. Initial local build failed because
Turbopack rejects external node_modules symlinks; replaced only owned symlink with
independent APFS dependency copy, then successful build. No live dependency changes.

Sanitized logs /private/tmp/ziyrak-p1-{administration,admin-ui-probe}-\*.log; red/green
identities/private source snapshot use admin-ui-probe-red/green-identity.json and
admin-ui-probe-red-source. Private synthetic fixture file is not committed or printed.

## Required next verification

J21 extends actual five-role UI to explicit denial, absent controls/nav/protected
fetches and immutable owner row while preserving APIs/foreign-workspace assertions.
J23 executes real secured provisioning/login/normal+restricted key CRUD, nested409
text, ownerUI demotion→actualPOST403/clear, narrowed-scope RSC reset and held keyGET
completion/cancellation, exact actual issuer/role/resource/profile ceiling, safe prefix
only after secret dialog, and selected workspace change without stale rows/form.
Restricted scope/extra membership are labelled seeded prerequisites, not P3 invitations.

Focused J21/J23 and fresh complete23 browser on identified matching candidate remain
NOT RUN. Freeze candidate, inspect both Administration and support-table screenshots,
record build/source/topology/outcome, then exact owned cleanup. Required new browser
acceptance stays open. Do not use old22pass for changed product.

P1 incomplete/P2 ineligible. Separate follow-up WIP19focused16pass3fail remains;
owner selected schedules surviving logout, rule11 send cutoff and R3 risk acceptance
still undecided. No real provider/account/live main/userDB/deploy/newmilestone action.

## First focused candidate

Code533201c, runtime9ef3e10/build6mYAOG-5q19Hq9yF137wW/
digeste62c7bf9594f6eca3286c0888e1937c2fd8aa7b02d753747c81c7100ceea9b1c.
Focused J21 passed exit0: five actual roles/positive rows, explicit denial/no admin
client fetches/controls/nav for denied roles and no generic owner-row mutations.
Focused J23 failed: two boolean evidence assertions expected psql-style f but this
repository SQL helper returns false; later controlled extra-membership INSERT used
a nonexistent updatedAt column. No product failure established by those errors.
Do not call J23 passed from intermediate checks. Fixed assertion and explicit fixture
columns/scope/profile, node --check passed. Complete affected new browser required.
Exact owned focused topology stopped; remainingOwned=[] verified. Focus logs use
/private/tmp/ziyrak-p1-administration-focused-{j21,j23,build}.log; DB/profiles retained.
Next fresh clone of ORIGINAL stopped support-list fixtures for corrected J23, then
new empty database complete23. Prior cloned database must not be reset/cleaned.

## Corrected focused run and cross-tab finding

Runtime1208d3d/buildHNDaRpVjWn1UcaZjB6MWy, unchanged product
digeste62c7bf9594f6eca3286c0888e1937c2fd8aa7b02d753747c81c7100ceea9b1c:
corrected J23 and J22 both passed exit0 on the second clone of original stopped
support-list fixtures. No fresh-full claim. Inspected limited-list and workspace-reset
screenshots: padded table readable within keyboard-scroll region; B rows replace A
and old key form absent. Exact owned topology stopped; remainingOwned=[] verified.

Before stopping that frozen candidate, actual two-tab browser regression reproduced
a new wrong-workspace intent defect: admin legitimately in A and B opened A user
form, used actual second-tab workspace selector to choose B, then original UI POST
returned201 and persisted one membership in B. No workspace header was sent. This
is not backend permission bypass. Synthetic actor provisioned through authenticated
API; second membership is a controlled DB prerequisite. Private probe
/private/tmp/ziyrak-p1-admin-workspace-probe.cjs and -red.log contain sanitized outcome.
Initial probe logged its desired assertion failure but omitted harness finish(), so
its process exit0 is not a test pass; corrected finish before green execution.

Small repair passes fresh server businessId to AdminClient and overwrites
x-workspace-id in its sole fetch wrapper, covering all users/keys reads/mutations.
Existing server cookie/header conflict403 performs rejection before mutation; existing
client invalidation clears rows/forms/password/key and refreshes context. The header
is not authority. Independent security source review clear; no reviewer execution.
J23 now uses real second-tab workspace UI before old key form submission, requires
403, original A header, zero matching keys across either workspace and context reset.
Independent harness source recheck clear. Focused four files32passed, type/strictlint
passed. Final same-source full149files1464passed/1Redis-mode skip and signup80files924passed, both exit0. Fresh23 browser pending at this checkpoint.
Prepared -full.env target ziyrak_acceptance_p1_administration_20261015 created fresh,
migrated, Businesscount0 verified. No resets, live/provider/user DB actions.
