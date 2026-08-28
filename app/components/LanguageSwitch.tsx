import Link from "next/link";

type LanguageSwitchProps = {
  enHref: string;
  jaHref: string;
  current: "en" | "ja";
};

export default function LanguageSwitch({
  enHref,
  jaHref,
  current,
}: LanguageSwitchProps) {
  const base =
    "rounded-full px-3 py-1.5 text-xs font-bold transition-colors";
  const active = "bg-white text-black";
  const inactive = "text-gray-400 hover:bg-white/10 hover:text-white";

  return (
    <div className="fixed bottom-4 right-4 z-[80] flex items-center gap-1 rounded-full border border-white/10 bg-black/80 p-1 shadow-2xl backdrop-blur-xl">
      <Link
        href={jaHref}
        hrefLang="ja"
        className={`${base} ${current === "ja" ? active : inactive}`}
      >
        日本語
      </Link>
      <Link
        href={enHref}
        hrefLang="en"
        className={`${base} ${current === "en" ? active : inactive}`}
      >
        EN
      </Link>
    </div>
  );
}
