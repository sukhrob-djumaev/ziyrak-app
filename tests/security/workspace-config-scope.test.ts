import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";
import * as rules from "@/lib/automations/automation-rules/service";
import * as flows from "@/lib/flows/service";
import * as hooks from "@/lib/integrations/webhooks/service";
import { retryDelivery } from "@/lib/integrations/webhook-delivery";
import * as customers from "@/lib/customers/service";

/**
 * P1: automation rules, flows and webhooks act on every channel of the workspace, so a
 * connection-restricted member must not create, change or remove them; webhooks (stored
 * headers, delivery payloads) are not even readable to them. Rules and flows stay readable.
 */
let a: SeededBusiness;
let restricted: TenantContext;
let ruleId: string, flowId: string, hookId: string, deliveryId: string;

beforeEach(async () => {
  a = await seedBusiness("workspace-config-scope");
  const connection = await prisma.channelConnection.create({
    data: { businessId: a.businessId, type: "scope-test", name: "Line", isActive: true },
  });
  const admin = await addMember(a.businessId, "admin", "restricted-admin");
  restricted = {
    ...admin.ctx,
    resourceScope: {
      kind: "connections",
      connectionIds: [connection.id],
      customerProfileAccess: "read",
    },
  };
  ruleId = (
    await rules.create(a.ctx, { name: "Wide rule", type: "auto_tag", conditions: {}, actions: [] })
  ).id;
  flowId = (await flows.create(a.ctx, { name: "Wide flow" })).id;
  hookId = (
    await hooks.create(a.ctx, {
      name: "Wide hook",
      url: "https://example.invalid/h",
      headers: { Authorization: "synthetic-secret" },
      triggerOn: "ticket.created",
    })
  ).id;
  deliveryId = (
    await prisma.webhookDelivery.create({
      data: {
        businessId: a.businessId,
        webhookId: hookId,
        event: "e",
        payload: {},
        status: "failed",
      },
    })
  ).id;
});
afterEach(async () => {
  await cleanupBusiness(a.businessId);
});

const forbidden = { statusCode: 403 };

describe("P1 workspace-wide configuration under a connection-restricted member", () => {
  it("cannot create, update or delete automation rules", async () => {
    await expect(
      rules.create(restricted, { name: "x", type: "auto_tag", conditions: {}, actions: [] })
    ).rejects.toMatchObject(forbidden);
    await expect(rules.update(restricted, ruleId, { isActive: false })).rejects.toMatchObject(
      forbidden
    );
    await expect(rules.remove(restricted, ruleId)).rejects.toMatchObject(forbidden);
    expect(await prisma.automationRule.count({ where: { businessId: a.businessId } })).toBe(1);
  });

  it("cannot create, update or delete flows", async () => {
    await expect(flows.create(restricted, { name: "x" })).rejects.toMatchObject(forbidden);
    await expect(flows.update(restricted, flowId, { isActive: true })).rejects.toMatchObject(
      forbidden
    );
    await expect(flows.remove(restricted, flowId)).rejects.toMatchObject(forbidden);
    expect(await prisma.flow.count({ where: { businessId: a.businessId } })).toBe(1);
  });

  it("cannot read, change, retry or list webhooks and their deliveries", async () => {
    await expect(hooks.list(restricted, { skip: 0, take: 10 })).rejects.toMatchObject(forbidden);
    await expect(hooks.getById(restricted, hookId)).rejects.toMatchObject(forbidden);
    await expect(
      hooks.create(restricted, { name: "x", url: "https://example.invalid/x", triggerOn: "e" })
    ).rejects.toMatchObject(forbidden);
    await expect(hooks.update(restricted, hookId, { isActive: false })).rejects.toMatchObject(
      forbidden
    );
    await expect(hooks.remove(restricted, hookId)).rejects.toMatchObject(forbidden);
    await expect(
      hooks.listDeliveries(restricted, hookId, { skip: 0, take: 10 })
    ).rejects.toMatchObject(forbidden);
    await expect(
      hooks.findDeliveryForWebhook(restricted, hookId, deliveryId)
    ).rejects.toMatchObject(forbidden);
    await expect(retryDelivery(restricted, deliveryId)).rejects.toMatchObject(forbidden);
    expect(await prisma.webhook.count({ where: { businessId: a.businessId } })).toBe(1);
  });

  it("can still read automation rules and flows", async () => {
    expect((await rules.list(restricted, { skip: 0, take: 10 })).total).toBe(1);
    expect((await flows.list(restricted, { skip: 0, take: 10 })).total).toBe(1);
  });

  it("leaves workspace-wide administration unchanged", async () => {
    await expect(rules.update(a.ctx, ruleId, { isActive: false })).resolves.toBeDefined();
    await expect(flows.update(a.ctx, flowId, { isActive: true })).resolves.toBeDefined();
    await expect(hooks.getById(a.ctx, hookId)).resolves.toBeDefined();
    expect((await hooks.list(a.ctx, { skip: 0, take: 10 })).total).toBe(1);
  });

  it("cannot delete a shared customer profile (erasure already refuses the same case)", async () => {
    const customer = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Shared customer", phone: "+15550001111" },
    });
    const writer: TenantContext = {
      ...restricted,
      resourceScope: {
        ...(restricted.resourceScope as { connectionIds: string[] }),
        kind: "connections",
        customerProfileAccess: "write",
      },
    };
    await expect(customers.remove(writer, customer.id)).rejects.toMatchObject(forbidden);
    expect(await prisma.customer.count({ where: { id: customer.id } })).toBe(1);
    await expect(customers.remove(a.ctx, customer.id)).resolves.toBeUndefined();
  });
});
