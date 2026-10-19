export class CrossTenantWriteError extends Error {
  constructor(model: string) {
    super(
      `Refusing to write a ${model} row tagged for a different business than the current tenant context (PLAN.md §8.3) — the scoped client never silently overrides a caller-supplied businessId on create, it rejects the write.`
    );
    this.name = "CrossTenantWriteError";
  }
}
