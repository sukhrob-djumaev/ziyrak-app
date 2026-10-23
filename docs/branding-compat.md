# Ziyrak naming: retained compatibility identifiers (R5)

R5 renamed active product text, assets, Tailwind color tokens (`ziyrak-*`), the package name and the local image
tag (`ziyrak:local`). The identifiers below keep the legacy `owly` name on purpose, because renaming them would
sign users out, orphan data or break external consumers. `tests/unit/r5-branding-scan.test.ts` fails on any other
Owly/Owl text in `src`, `public`, README, SECURITY, CONTRIBUTING and `package.json`.

| Identifier | Why it stays | Safe transition |
| --- | --- | --- |
| Session cookie `owly-token` | Renaming signs every user out and changes the security-reviewed cookie contract. | Dual-read cookie in a dedicated auth change with its own security review. |
| Default Redis key prefix `owly:` (`REDIS_KEY_PREFIX`) | Queues, cache and rate-limit state live under it. | Set `REDIS_KEY_PREFIX` to a new value at a quiet moment after draining queues. |
| Webhook header `X-Owly-Signature` | Existing receivers verify it. | Both `X-Ziyrak-Signature` and `X-Owly-Signature` are sent with the same value; remove the legacy one after receivers move. |
| Database names `owly`, `owly_test`, `owly_load`, compose `POSTGRES_DB`, CI service DB | Live/dev databases and volumes are named by it. | Never rename a live database as cosmetics; new installs may choose any name. |
| Compose Redis password default `owly-local-redis` | Local-only default; changing it breaks running local containers. | Set `REDIS_PASSWORD`. |
| Helm chart `helm/owly`, helper names `owly.*`, image `ghcr.io/hesper-labs/owly` | Deployed release and registry names. | New chart/registry path with a release migration plan. |
| GitHub URLs `Hesper-Labs/owly`, `hsperus/owly` | Upstream repository provenance and license links. | None needed. |
| Legacy localStorage keys `owly-theme`, `owly-onboarding-dismissed` | Read once and migrated to `ziyrak-theme` / `ziyrak-onboarding-dismissed`. | Remove migration code later. |
| `public/ziyrak.png` artwork | The file was renamed, but the picture is still the former owl mascot. | Replace with the final Ziyrak logo (owner supplies art). |
| History: `CHANGELOG.md`, `PLAN.md` records, `docs/*archive*`, `docs/implementation-history.md`, `.agent/` | Historical evidence is not rewritten. | None. |
| `docs/screenshots/*.png` | Captured before the rename; regenerate with `scripts/screenshots.mjs` when needed. | Regenerate. |
