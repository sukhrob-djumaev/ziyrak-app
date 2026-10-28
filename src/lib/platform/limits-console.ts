import { z } from "zod";
import { AppError } from "@/lib/observability/errors";
import { withPlatformControl } from "./access/authority";
import { writePlatformAudit } from "./access/audit";
import { PLATFORM_LIMITS, PLATFORM_LIMIT_KEYS, readLimit, type PlatformLimitKey } from "./limits";

/** L4.1c - super-admin management of the platform limits. Every change is audited with a reason. */
const setInput = z
  .object({
    key: z.enum(PLATFORM_LIMIT_KEYS as [PlatformLimitKey, ...PlatformLimitKey[]]),
    value: z.number().int().min(0),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export async function setPlatformLimit(token: string, input: unknown) {
  const parsed = setInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid platform limit request");
  const { key, value, reason } = parsed.data;
  if (value > PLATFORM_LIMITS[key].max) throw new AppError(400, "VALIDATION_ERROR", `The largest allowed value is ${PLATFORM_LIMITS[key].max}`);
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const before = await readLimit(tx, key);
    const saved = await tx.platformLimit.upsert({
      where: { key },
      create: { key, value, updatedBy: actor.userId },
      update: { value, updatedBy: actor.userId },
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "platform.limit.set",
      reason,
      details: { key, before, after: saved.value },
    });
    return { key, value: saved.value };
  });
}
