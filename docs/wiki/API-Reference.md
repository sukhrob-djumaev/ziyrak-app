# API Reference

This wiki entry was superseded on 2026-10-25. Use the [current guide](../guides/operator-setup.md) and [documentation index](../README.md).

For current feature support, permissions and known gaps, see the [dashboard review](../dashboard-and-access-review-2026-10-25.md). Flexible subscriptions are a [target contract](../billing-and-entitlements-spec.md), not shipped functionality.

The [original page](../legacy-wiki/API-Reference.md) is preserved for history only. Its setup, security, channel, role and pricing instructions may be obsolete; it is not current operating guidance.

The application also exposes `/api/openapi.json`, implemented in [the schema route](../../src/app/api/openapi.json/route.ts). It is a manually maintained schema, not a newly verified exhaustive contract; its old contact/channel descriptions still need L3 reconciliation. Use actual routes/services and permission tests when implementing against it.
