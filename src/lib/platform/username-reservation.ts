import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/observability/errors";

/** Coordinate every public/workspace/platform identity creator. The DB's
 * case-sensitive username key alone cannot exclude concurrent case variants.
 * Hash collisions only serialize unrelated names; the lookup is authoritative.
 * Call inside the same transaction that inserts the new User, after hashing.
 */
export async function reserveNewUsername(tx: Prisma.TransactionClient, username: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(92843, hashtext(lower(${username})))`;
  if (
    await tx.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      select: { id: true },
    })
  )
    throw new AppError(409, "USERNAME_TAKEN", "That username is already taken");
}
