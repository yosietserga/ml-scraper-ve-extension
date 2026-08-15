"use client";

interface SectionHeadingProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function SectionHeading({
  title,
  subtitle,
  right,
}: SectionHeadingProps) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-gray-900">{title}</h2>
        {subtitle ? (
          <p className="text-sm text-gray-500">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
}: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
}) {
  return (
    <div className="empty">
      {icon ? (
        <div className="mb-2 text-3xl text-gray-300">{icon}</div>
      ) : null}
      <div className="font-semibold text-gray-700">{title}</div>
      {message ? (
        <p className="mt-1 max-w-md text-sm text-gray-500">{message}</p>
      ) : null}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  return (
    <div className="empty">
      <div className="spinner mb-3" />
      <div className="font-semibold text-gray-700">
        {label || "Cargando datos…"}
      </div>
    </div>
  );
}
