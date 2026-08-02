// FR-023: every timestamp shown to the user renders in their local time zone
// through these helpers — no page formats dates on its own (T044).

export function formatLocal(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeAge(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function draftCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "draft time has passed";
  const days = Math.floor(ms / 86400_000);
  const hours = Math.floor((ms % 86400_000) / 3600_000);
  const mins = Math.floor((ms % 3600_000) / 60_000);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}
