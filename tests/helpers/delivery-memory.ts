import { vi } from "vitest";
/** In-memory delivery delegate for mocked characterization tests only.
 * Real persistence, transactions and tenant isolation have separate Postgres suites.
 */
export function installDeliveryMemory(client: Record<string, unknown>) {
  const delegate = client.deliveryOperation as Record<string, ReturnType<typeof vi.fn>>;
  type Row = Record<string, unknown>;
  const rows = new Map<string, Row>();
  const find = (where: Row) =>
    where.id
      ? rows.get(String(where.id))
      : [...rows.values()].find(
          (row) => row.operationKey === (where.businessId_operationKey as Row).operationKey
        );
  delegate.upsert.mockImplementation(async ({ where, create }: { where: Row; create: Row }) => {
    const existing = find(where);
    if (existing) return existing;
    const row = {
      id: "characterization-delivery-" + rows.size,
      response: null,
      attempts: 0,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...create,
    };
    rows.set(row.id, row);
    return { ...row };
  });
  delegate.findUnique.mockImplementation(async ({ where }: { where: Row }) => find(where));
  delegate.findUniqueOrThrow.mockImplementation(async ({ where }: { where: Row }) => {
    const row = find(where);
    if (!row) throw new Error("Missing delivery fixture");
    return { ...row };
  });
  delegate.updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
    let count = 0;
    for (const row of rows.values()) {
      const matches = Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && "in" in value)
          return (value.in as unknown[]).includes(row[key]);
        if (value && typeof value === "object" && "lt" in value)
          return row[key] instanceof Date && (row[key] as Date) < (value.lt as Date);
        if (key === "updatedAt") return (row[key] as Date).getTime() === (value as Date).getTime();
        return row[key] === value;
      });
      if (!matches) continue;
      for (const [key, value] of Object.entries(data))
        row[key] =
          value && typeof value === "object" && "increment" in value
            ? Number(row[key]) + Number(value.increment)
            : value;
      row.updatedAt = new Date();
      count++;
    }
    return { count };
  });
  (client.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (fn: (tx: unknown) => unknown) => fn(client)
  );
}
