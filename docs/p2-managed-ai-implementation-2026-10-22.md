# P2 managed AI and usage limits: implementation record (2026-10-22)

Design: `docs/p2-managed-ai-proposal-2026-10-22.md` (approved by the owner 2026-10-22).
Status: implemented on branch `p2-managed-ai`; verification below. Not merged, not deployed.

## Behavior (what operators and customers can rely on)

- **Units and period.** Tokens (prompt + completion for generation; input tokens for embeddings),
  separate generation and embedding limits per workspace, per UTC calendar month. Defaults for a new
  allowance: 500,000 generation and 1,000,000 embedding tokens; the super admin changes them per
  workspace. Limits are usage caps, not invoices.
- **Reservation.** Before every potentially billable attempt (each tool-loop iteration, each retry,
  each embedding, knowledge test, indexing job) a conservative bound is reserved under a row lock on
  the workspace allowance: estimated prompt (characters / 3) plus the policy's max completion tokens.
  Over the remaining allowance: refused, no provider call.
- **Settlement.** A finished call settles to the provider-reported total (it can exceed the bound; the
  next reservation then sees it). Failures that cannot have billed (`auth`, `invalid_request`,
  `rate_limit`) release the reservation. Timeouts, provider errors with unknown outcome and non-provider
  errors keep the reserved bound charged (`uncertain`). A retry reserves again, so a retried timeout is
  charged twice by design.
- **Recovery.** A reservation still `reserved` after 10 minutes (worker crash) is swept every five
  minutes to `uncertain` and stays charged. A late result may still settle an `uncertain` row to actual.
  A finished attempt's idempotency key cannot authorize another call.
- **Fail closed.** If the ledger cannot be written, no paid call starts: chat replies with the human
  handoff message and escalates the conversation (inbound message kept), indexing is skipped, query
  embedding falls back to keyword search, the knowledge test returns 429.
- **Resolution.** A workspace in `managed` mode uses only the active platform policy for its kind; it
  never uses its own `BusinessConfig` provider/model/key or the legacy global key. No policy: "not
  configured", no provider call. Workspaces with no allowance row or `legacy_byok` behave as before.
  `InfrastructurePolicy` still narrows providers at the call sites.
- **Customer surface.** Settings > AI shows service name, usage, limit, status and reset date; writes
  are refused (`AI_MANAGED`). The knowledge test response omits the model and returns generic errors.
- **Super admin.** `/platform/ai-service` (`/api/platform/ai-service`): versioned policies with
  write-only encrypted keys, per-workspace mode/status/limits; every change audited (no secrets).
- **Migration.** `npm run ai:legacy-migration` (dry run default; `--apply`; `--rollback <file>`) only
  records `legacy_byok` for workspaces that already hold their own key. No key is moved, deleted or
  decrypted; moving a workspace to managed is a deliberate audited console action.

## Known limits (accepted)

- Prompt size is estimated at characters / 3; non-Latin text can tokenize denser, so a call can settle
  above its bound. The overshoot is bounded by the per-call prompt limit and the next reservation is
  refused. Caps are not exact invoices.
- The cached query embedding is keyed by workspace, provider and query hash, not by policy model.
  After an embedding policy model change, stale cached query vectors can live up to one hour.
- A "provider outage" status is not reported separately; outages appear as fallback replies and
  `uncertain` charges.
- Replies on a `rate_limit` are released; a provider that bills rate-limited calls is not modeled.

## Verification record (update as evidence is added)

- Unit/real-PG: 167 files, 1655 passed, 23 skipped on an isolated database (tsc, lint clean).
- Independent agent security review (read-only): findings 1, 3, 5, 6 fixed with tests; finding 2
  already covered (engine, test route and indexing stop on a missing key before any reservation);
  findings 4 and 7 accepted (see limits).
- Browser: candidate `ffbeeef`, fresh DB `ziyrak_acceptance_p2_managed_20261022b`, headless system
  Chrome, stand-in provider, Redis 6381 (prefix ziyrak_acc_p2_final:). J01-J26 passed in one run; J27
  passed on the same build after journey-script-only fixes (field clearing, numeric compare, generation-only
  exhaustion check). Screenshots inspected: owner panel (normal and exhausted), super-admin console.
- Real provider: `tests/integration/managed-ai-live.test.ts` against real OpenAI (3/3).
- Not covered: windowed-browser mode; real provider through the browser; human review.
