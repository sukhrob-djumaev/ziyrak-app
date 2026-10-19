-- Retirement is monotonic and independent of whether an external effect completed.
ALTER TABLE "Conversation" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "ActionExecution" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "DeliveryOperation" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "InboundEventReceipt" ADD COLUMN "retiredAt" TIMESTAMP(3);
