-- L5.2: members the owner did not keep when the plan's seat limit dropped, and the owner's "who stays" choice.
ALTER TABLE "Membership" ADD COLUMN "suspendedByPlanAt" TIMESTAMP(3);
ALTER TABLE "BillingSubscriptionItem" ADD COLUMN "pendingStayers" JSONB;
