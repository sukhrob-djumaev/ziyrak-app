# Latest handoff — launch documentation reset, 2026-10-25

- Owner asked to update stale docs/restart the process, plan flexible feature-based subscriptions and recheck dashboard,
  roles/access and usability. Selected LP-2026-10-25 launch preparation; L7 deployment/live money remains unapproved.
- L0 complete: README/PLAN/AGENTS, SECURITY/CONTRIBUTING, env example, docs index, current operator/customer guides,
  launch roadmap, billing target contract and dashboard review. Original wiki pages preserved byte-for-byte under
  `docs/legacy-wiki/`; old paths now redirect. Numbered architecture body and dated evidence remain historical.
- Product code/dependencies/DB/provider configuration unchanged. No app/browser/provider tests rerun for docs work.
- Independent read-only AI-agent documentation and dashboard investigations integrated. Independent contract review
  corrected sandbox/live gate separation, approval safety, grant composition, source pointers and implementation
  ownership for MFA/abuse/spend controls. No human security audit or measured usability study claimed.
- Verification: source/commands/env cross-check, relative-reference check, original wiki byte comparison, Git diff check.
  Detailed results in `docs/evidence/launch-rebaseline-2026-10-25.md`; application evidence remains prior audit only.
- Billing target: typed code-owned capability registry plus versioned data-owned catalog and provider adapter;
  super-admin manages offers, owners manage purchases; server/worker enforce role+scope+entitlement+availability.
  No-code repricing/packaging does not imply no-code new features. Existing subscriptions retain versioned terms.
- Working offer base+add-ons, not final production prices. Merchant country/first currency/provider, trial/grace,
  cancellation/refund/tax policy and production support/reporting contact remain L4.2 decisions.
- Next: L1.1 safe test harness in isolation, then ordered launch tasks. No old phase restart, no payment activation.
- Git: previous audit `3066b33`; this rebaseline is identified by its containing local docs commit. No push/deploy.
- Preserve live-worker isolation, paired DB URLs, protected port7700 and owned-process fencing. Review scratch
  `/private/tmp/ziyrak-review-20261025-8aZznQ` remains; docs work created no DB/services. Do not assume old resources exist.
- Historical runtime: R5 30/30 browser/1812 passed+1 skipped; Meta A recipient-visible on `905b4ca`; B not retested,
  waiver not pass; historical Gmail single message not production-domain token-flow acceptance. Fresh Oct25 audit:
  53 focused tests/tsc/lint passed; build environment-blocked; full DB/Redis/browser/provider not rerun.
