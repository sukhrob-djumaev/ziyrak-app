# Ziyrak naming

The product, package, cookie (`ziyrak-token`), Redis key prefix (`ziyrak:`), webhook header (`X-Ziyrak-Signature`),
database names (`ziyrak`, `ziyrak_test`, `ziyrak_load`), Helm chart (`helm/ziyrak`), image tag (`ziyrak:local`) and
localStorage key (`ziyrak-theme`) all use the Ziyrak name. No legacy-name compatibility shims remain.

`tests/unit/r5-branding-scan.test.ts` fails if the previous product name reappears in any tracked text file.

Rename migration notes (one-time, done 2026-10-29): existing sessions signed out once because the cookie name changed;
Redis state under the old prefix was not carried over; local databases were renamed with `ALTER DATABASE`.

`public/ziyrak.png` is a square crop of the final Ziyrak mark (brain + bolt), supplied by the owner 2026-10-24; the source
art is low resolution (882x324 lockup, kept as `public/ziyrak-logo.png`). Replace both with vector art when available.
`docs/screenshots/*.png` were captured before the rename; regenerate with `scripts/screenshots.mjs` when needed.
