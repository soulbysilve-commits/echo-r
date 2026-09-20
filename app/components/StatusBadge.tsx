const LABEL_EN: Record<string, string> = {
  VERIFIED: "Shipped",
  PARTIAL: "In progress",
  EXPERIMENTAL: "Experimental",
  PLANNED: "Planned",
  FAILED: "Known issue",
  DEPRECATED: "Deprecated",
};
const LABEL_JA: Record<string, string> = {
  VERIFIED: "実装済み",
  PARTIAL: "開発中",
  EXPERIMENTAL: "実験段階",
  PLANNED: "開発予定",
  FAILED: "既知の課題",
  DEPRECATED: "非推奨",
};
const COLOR: Record<string, string> = {
  VERIFIED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  PARTIAL: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  EXPERIMENTAL: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  PLANNED: "bg-gray-500/15 text-gray-300 border-gray-500/30",
  FAILED: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  DEPRECATED: "bg-gray-500/15 text-gray-400 border-gray-500/30",
};

// Every AVAILABLE NOW / IN DEVELOPMENT / RESEARCH-style label on the site
// should route through this component so the wording for a given STATUS is
// defined in exactly one place (mandate section 7).
export default function StatusBadge({ status, locale = "en" }: { status: string; locale?: "en" | "ja" }) {
  const label = (locale === "ja" ? LABEL_JA : LABEL_EN)[status] ?? status;
  const color = COLOR[status] ?? "bg-gray-500/15 text-gray-300 border-gray-500/30";
  return (
    <span className={`inline-block rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${color}`}>
      {label}
    </span>
  );
}
