# P2 managed AI and usage limits: proposal for owner review (2026-10-22)

Status: PROPOSAL. No code written. PLAN P2 says allowance values and limit-facing behavior
await an owner-reviewed proposal; this is that proposal. Governing text: PLAN P2, §10.2, §21,
§39.2.

## 1. What exists today (from source)

- `resolveAIConfig` / `resolveEmbeddingConfig` (`src/lib/ai/config.ts`) read provider, model,
  limits and an encrypted key from `BusinessConfig` (customer-editable via `PUT /api/settings/ai`),
  with a legacy `Settings` fallback for the Default Business only.
- Generation call sites: `ai/engine.ts` `callAI` (recursive tool loop, depth <= 5, plus one retry on
  retryable errors) and `api/knowledge/test`. Embedding call sites: `knowledge/indexing.ts`
  (queued job) and `knowledge/semantic-search.ts` (per query).
- `recordAIInteraction` writes `AIInteractionLog` after the call, best effort. It cannot cap
  anything: it runs after spend, can fail silently, and ignores failed or uncertain attempts.
- `InfrastructurePolicy` (control plane) only narrows permitted provider names per workspace.
- Without a key the chat replies "AI is not configured. Please add your API key in Settings".

## 2. Proposed model (smallest extension)

Control-plane tables, never tenant-writable:

1. `AiServicePolicy` (versioned, one active row per kind `generation|embedding`): provider,
   model, encrypted credential (same SecretResolver envelope as today), maxTokens, temperature,
   per-call bounds (max prompt tokens, max completion tokens, max tool-loop depth).
2. `WorkspaceAiAllowance` (one per workspace): assigned policy ids, `periodUnit` (calendar
   month UTC), `limitTokens` per kind, `status` (active|suspended), `version`.
3. `AiUsageReservation`: id, workspaceId, kind, periodStart, reservedTokens, state
   (`reserved|settled|released|uncertain`), settledTokens, idempotencyKey (unique), createdAt,
   expiresAt. Counters are derived by sum over open + settled rows in one transaction with a
   per-(workspace, period) row lock (`SELECT ... FOR UPDATE` on the allowance row); no
   separate counter to drift.

Resolution: `resolveAIConfig` ignores `BusinessConfig` provider/model/key for managed
workspaces; it loads the assigned policy, validates it against `InfrastructurePolicy`, and
returns it. Missing, suspended or invalid policy returns a typed error, never another
workspace's key. `BusinessConfig` keeps behavior fields only. `PUT /api/settings/ai` rejects
provider/model/key fields for managed workspaces (403 `AI_MANAGED`).

## 3. Enforcement (reserve, call, settle)

Before every potentially billable attempt (each tool-loop iteration, each retry, each embedding
batch element, test replies, queued indexing): reserve a conservative bound
`promptEstimate + maxCompletionTokens` (prompt estimated as ceil(chars/3), min bound floor).
Insert reservation and check `used + reserved + request <= limit` inside one transaction under the
allowance row lock. Over the limit: refuse with `AI_ALLOWANCE_EXHAUSTED`, no provider call.
After the call: settle to actual provider usage (never above the reservation unless the provider
reports more, then record the excess and clamp the next reservation). Provider error before any
billing signal: release. Timeout or unknown outcome: mark `uncertain`, keep charged at the
reserved bound. Retries reserve again (each attempt is billable). Idempotency key =
`conversation:message:attempt` (or job id + attempt) so a replayed job cannot double reserve.
Expired `reserved` rows (worker crash, default 10 min) are swept to `uncertain` and stay charged.
Accounting failure (DB error reserving): fail closed for new paid work. Inbound message stays
stored, conversation marked for human handling, customer gets the existing fallback copy.
`AIInteractionLog` stays as analytics and is written from settlement, not used for caps.

## 4. Customer and super-admin surface

- Super admin (platform console): create/version policies and credentials (write-only keys),
  assign policy and limits per workspace, suspend, see usage.
- Customer (Settings > AI, read only): service name, tokens used / limit for the period,
  reset date, status (ok | near limit at 80% | exhausted | not configured | provider outage),
  and the recovery text ("limit resets on <date>; contact the platform operator; conversations
  keep flowing to your team"). No key, model id or policy internals beyond display name.

## 5. Migration of existing tenant settings

Explicit, tested, reversible: a script (dry-run by default) lists workspaces with a stored
tenant key. Nothing is deleted or silently switched. Default outcome: those workspaces keep a
`legacy_byok` mode (their own stored key keeps working, uncapped by token allowance but still
policy-narrowed) until the owner flips them to managed per workspace. Backup: dump of
`BusinessConfig` credential refs and `Settings` before any flip; rollback = flip mode back.

## 6. Verification plan

Tests first: secret and permission contracts (customer cannot read or write provider fields,
no key in any customer response/log), isolation (workspace A exhaustion never affects B), real-PG
concurrency (N parallel reservations never exceed limit), crash/expiry recovery, replay
idempotency, accounting-failure fail-closed, unit fixtures with the fake provider. Then
independent security review, full unit suite, full browser run, and one targeted real
generation + embedding call through the managed path (needs a platform OpenAI key, a user action).

## 7. Decisions needed from the owner

1. **Period and units:** calendar-month UTC, total tokens (prompt + completion), separate
   generation and embedding limits. Agree?
2. **Default allowance for a new managed workspace:** suggest generation 500,000 tokens/month
   and embedding 1,000,000 tokens/month as placeholders; super admin can change per workspace.
   Your numbers?
3. **Existing workspaces:** keep `legacy_byok` until flipped (recommended, no surprise switch), or
   flip all to managed on rollout?
4. **Exhausted behavior:** customer-facing fallback reply + auto handoff to a human (recommended),
   or silent no-reply?
5. **Uncertain outcomes:** charge the reserved bound (conservative, recommended) or release?
6. **Real-provider check:** can you supply a platform OpenAI key for the targeted call when we
   reach verification (never committed, entered via the platform console)?
