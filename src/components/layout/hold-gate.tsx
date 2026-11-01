"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { holdAllowsPagePath } from "@/lib/billing/hold-paths";

/** While the workspace is on payment hold, every page except billing and the person's own account shows this instead. The API refuses too. */
export function HoldGate({
  retentionEndsAt,
  isOwner,
  children,
}: {
  retentionEndsAt: string | null;
  isOwner: boolean;
  children: React.ReactNode;
}) {
  const path = usePathname();
  if (holdAllowsPagePath(path)) return <>{children}</>;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div role="alert" data-testid="payment-hold" className="max-w-md text-center">
        <h2 className="text-lg font-semibold text-ziyrak-text">This workspace is paused</h2>
        <p className="mt-2 text-sm text-ziyrak-text-light">
          {isOwner
            ? "The subscription has ended, so replies and the dashboard are paused. Messages from customers are still being saved. Pay to resume everything straight away."
            : "Payment is needed to resume this workspace. Please contact the workspace owner."}
        </p>
        {retentionEndsAt && (
          <p className="mt-2 text-xs text-ziyrak-text-light">
            Your data is kept until {new Date(retentionEndsAt).toLocaleDateString()}.
          </p>
        )}
        <Link href="/billing" className="mt-4 inline-block text-sm font-medium text-ziyrak-primary hover:underline">
          {isOwner ? "Go to billing" : "View billing status"}
        </Link>
      </div>
    </div>
  );
}
