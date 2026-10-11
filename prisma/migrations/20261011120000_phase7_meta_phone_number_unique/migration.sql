-- A Meta phone_number_id routes inbound WhatsApp traffic to exactly one
-- business. The application checks ownership before saving, but a check-then-
-- write race (or a direct write) could still let two active connections claim
-- one number; routing then fails closed for both. This partial expression
-- index makes the claim exclusive in the database itself. Prisma cannot model
-- expression indexes, so it lives only here.
CREATE UNIQUE INDEX "ChannelConnection_whatsapp_cloud_phoneNumberId_active_key"
  ON "ChannelConnection" ((config ->> 'phoneNumberId'))
  WHERE type = 'whatsapp_cloud' AND "isActive" = true AND config ->> 'phoneNumberId' IS NOT NULL;
