"use client";

import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  accent?: "navy" | "green" | "yellow";
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent = "navy",
}: StatCardProps) {
  const accentBg =
    accent === "green"
      ? "bg-ml-green"
      : accent === "yellow"
      ? "bg-ml-yellow"
      : "bg-ml-navy";
  const accentText =
    accent === "yellow" ? "text-ml-navy" : "text-white";
  return (
    <div className="card card-hover flex items-center gap-3">
      {Icon ? (
        <div
          className={clsx(
            "flex h-10 w-10 items-center justify-center rounded-lg",
            accentBg,
            accentText
          )}
        >
          <Icon size={20} />
        </div>
      ) : null}
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {label}
        </div>
        <div className="truncate text-xl font-bold text-gray-900">
          {value}
        </div>
        {hint ? (
          <div className="truncate text-xs text-gray-500">{hint}</div>
        ) : null}
      </div>
    </div>
  );
}
