# P1 Settings permission and request context evidence

Status: implemented in isolated p1-support-identity/owly based893cb41;
coherent Settings commit/full24 browser pending. Main docs-only. Governed by
[contract](p1-settings-context-contract-2026-10-15.md) and PLAN P1. No P2 managed-AI
ownership, provider/API/schema changes, external calls or release authorization.

## Implementation

Fresh settings:read server wrapper and navigation gate; capability derives current
settings:update, preserving restricted-admin permission. Opaque actor/workspace/
placement/session/scope key replaces client forms on RSC refresh. All Settings reads
and writes carry rendered x-workspace-id, existing API conflict guard remains authority.
Abort/per-URL supersession/load generation and final freshness checks prevent stale
updates. Known401/403 invalidates all pending work, clears entire configuration,
credential input, legacy/configured/toast/timer state and refreshes server context.
Ordinary load errors offer Retry; legacy panels require their own successful read.

Independent review found inherited legacy mask overwrite on unrelated saves. Display
mask/empty baselines now publish only after fresh successful load; unchanged secret
operands omitted. Explicit replacements/clears retained. Fresh save normalizes only
still-same submitted input and updates baselines, preserving later edits. API masking
and storage contracts unchanged. J21 adds actual5roleSettings controls/nav/no denied
fetch. J24 adds profile/cross-tab/read reset/restricted permission/demotion and
synthetic Default-Business legacy preservation/rotation/clear/error+Retry workflows.
Controlled scope/extra membership/default slug and injected500 are explicitly labelled.

## Executed evidence

- Real isolatedPG/JWT/cookie SSR12: final tests-first8desiredfailures/4positives before
  product change; first draft Headerfixture omitted description and caused3 spurious
  positive failures, corrected before final red. After implementation affected5files53
  passed; type/strictlint passed, repeated after legacy fix. Reviewer executed no checks.
- Actual trustedChrome/realPG own3200 before fix: oldAform/actualsecondTabBselection
  PUT200 persisted changedB; ownerAPI demotion then actualAI save403 retained typed
  credential; injectedlegacy500 still enabledlegacy panels. Corrected repeat exited1.
  Red buildmd47qPbSnCwESeNBE0a-w/digest6a4381cb48d249080ecd82b84c052c9180bdc0cc7ce54e4517ea8d3fe78f3263.
  First probe used wrong Save button label and needed explicit return-tab focus; those
  harness errors excluded. Corrected repeat uses actual Save and foregrounded tab.
- Initial fixed UI buildWGU_QhnpzBXRUE8Zots0F/
  digest4a2328bd55e4aa973b2f46210213726ea5617e1671bbb14a632e7bdd2a1d1871:
  first3checks green; separate actuallegacyEmail nonsecret save200 overwrote BOTH seeded
  SMTP/IMAP secrets and submitted both masks (booleans/fieldnames only logged), desired
  assertionfailed/exit1. Initial fixture assumed existing Settings row; corrected via
  real authenticated Default-Business GET before recording that result.
- Final green buildlO08aKtMCjit61Fs2580W/
  digest45f6b5e938e6393a402aebdaa7ca30dc6c020bc64d1b862804162b13622147d3:
  all6actual/injected checks passed exit0: cross-tab403/headerA/no Bwrite, demotion403
  removes credential input, injectedlegacy500 hides panels, unrelatedsave omits both
  secret fields/preserves originals, explicitSMTP replacement and explicitclear both
  preserve IMAP. No provider call. Original synthetic legacy credentials restored.
- Independent security source closure clear after mask repair, no reviewer execution.
  Final full150files1476passed/1Redis-mode skip and signup81files936passed, both exit0.
  Independent J21/J23/J24 source closure clear after corrected CDP URL string handling; reviewers executed no checks. Actual new browser acceptance remains pending. Existing
  Administration23pass is different source.
  HarnessCJS is excluded by repository ESLint configuration; explicit file lint returned
  ignore warnings, not findings. Node syntax/Prettier/source review cover the harness.

Probe uses own ziyrak_acceptance_p1_admin_ui_probe_20261015 with pairedURLs, private
admin-ui-probe.env; synthetic signup/provision/login through product paths. B reserved
slug and extra membership are controlled prerequisites. Scripts/identities/logs
/private/tmp/ziyrak-p1-settings-{ui-probe.cjs,probe-\*}; synthetic credentials are private,
never printed/committed. Red/initial/final owned server/browser stopped and absent
verified before subsequent source changes. DB/profiles retained. SharedPG/taskRedis
retained. No live7700/provider/account/user DB changes. P1 incomplete/P2 ineligible.

Required next: finish independent J21/J24 source review, coherent commit,
matching isolated runtime build, focused new journeys if useful, then fresh empty DB
full24 with exact identity/screenshots/cleanup. No acceptance waiver inferred from
schedule-survives-logout choice; follow-up cutoff/R3 decisions remain separate.
