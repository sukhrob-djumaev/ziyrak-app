/**
 * L5.1 - pure subscription state machine (docs/l5-payment-lifecycle-design.md section 5, Revisions 2-3).
 * The next local state is derived only from an authoritative provider snapshot, the previous local state and the
 * policy, so applying the same snapshot twice, or an older one after a newer one, can never move state backwards.
 * Nothing here touches the database or the clock beyond the `now` it is given.
 */
export type LocalStatus = "incomplete" | "active" | "past_due" | "canceling" | "ended";

export interface LocalSubscriptionState {
  status: LocalStatus;
  graceEndsAt: Date | null;
  lastFetchedAt: Date | null;
}

export interface ProviderSnapshot {
  /** The provider's own status string, kept raw so unknown values are visible rather than coerced. */
  providerStatus: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date;
  /** Taken before the provider call; orders snapshots, not the provider event time. */
  fetchedAt: Date;
}

export interface ApplyResult {
  state: LocalSubscriptionState;
  /** Whether the provider purchase should currently grant access. */
  grantsAccess: boolean;
  /** Grace elapsed while unpaid: the caller must cancel the provider subscription (outside the tenant lock). */
  cancelAtProvider: boolean;
  /** Set when the snapshot contradicts a terminal state; needs owner/operator review, never reactivates access. */
  incident: "paid_after_end" | null;
  stale: boolean;
}

const DAY_MS = 86_400_000;

export function applySnapshot(
  prev: LocalSubscriptionState,
  snapshot: ProviderSnapshot,
  policy: { graceDays: number },
  now: Date,
): ApplyResult {
  const result = (state: LocalSubscriptionState, extra: Partial<ApplyResult> = {}): ApplyResult => ({
    state,
    grantsAccess: state.status === "active" || state.status === "canceling" || (state.status === "past_due" && state.graceEndsAt !== null && now < state.graceEndsAt),
    cancelAtProvider: false,
    incident: null,
    stale: false,
    ...extra,
  });

  if (prev.lastFetchedAt && snapshot.fetchedAt < prev.lastFetchedAt) return result(prev, { stale: true });
  const fetched = { lastFetchedAt: snapshot.fetchedAt };

  const paidLike = snapshot.providerStatus === "active" || snapshot.providerStatus === "trialing";
  if (prev.status === "ended") {
    // Terminal: money arriving after the end is reviewed by a person, never turned back into access.
    return result({ ...prev, ...fetched }, { incident: paidLike ? "paid_after_end" : null });
  }

  switch (snapshot.providerStatus) {
    case "active":
    case "trialing":
      return result({ status: snapshot.cancelAtPeriodEnd ? "canceling" : "active", graceEndsAt: null, ...fetched });
    case "past_due":
    case "unpaid": {
      const graceEndsAt = prev.graceEndsAt ?? new Date(snapshot.fetchedAt.getTime() + policy.graceDays * DAY_MS);
      if (now >= graceEndsAt) return result({ status: "ended", graceEndsAt, ...fetched }, { cancelAtProvider: true });
      return result({ status: "past_due", graceEndsAt, ...fetched });
    }
    case "canceled":
    case "incomplete_expired":
      return result({ status: "ended", graceEndsAt: prev.graceEndsAt, ...fetched });
    case "incomplete":
      return result({ status: "incomplete", graceEndsAt: null, ...fetched });
    default:
      // Unknown status: record that we looked, keep the prior status, and grant nothing we cannot explain.
      return result({ ...prev, ...fetched }, { grantsAccess: false });
  }
}
