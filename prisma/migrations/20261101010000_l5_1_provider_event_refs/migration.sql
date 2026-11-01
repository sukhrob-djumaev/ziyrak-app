-- Normalized refs from the verified webhook, kept so a received event can be processed (or re-queued) without the raw body.
ALTER TABLE "ProviderEvent" ADD COLUMN "subscriptionRef" TEXT, ADD COLUMN "customerRef" TEXT, ADD COLUMN "clientReference" TEXT;
