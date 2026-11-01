-- A reduction the owner scheduled for period end: target quantity (0 = remove the item).
ALTER TABLE "BillingSubscriptionItem" ADD COLUMN "pendingQuantity" INTEGER;
