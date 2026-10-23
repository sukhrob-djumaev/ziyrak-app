import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  icon: LucideIcon;
  iconColor?: string;
}

export function StatCard({
  title,
  value,
  change,
  changeType = "neutral",
  icon: Icon,
  iconColor = "bg-ziyrak-primary-50 text-ziyrak-primary",
}: StatCardProps) {
  return (
    <div className="bg-ziyrak-surface rounded-xl border border-ziyrak-border p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-ziyrak-text-light">{title}</p>
          <p className="text-2xl font-bold text-ziyrak-text mt-1">{value}</p>
          {change && (
            <p
              className={cn(
                "text-xs mt-1 font-medium",
                changeType === "positive" && "text-ziyrak-success",
                changeType === "negative" && "text-ziyrak-danger",
                changeType === "neutral" && "text-ziyrak-text-light"
              )}
            >
              {change}
            </p>
          )}
        </div>
        <div className={cn("p-2.5 rounded-lg", iconColor)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}
