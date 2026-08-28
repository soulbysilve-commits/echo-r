import type { Metadata } from "next";
import LanguageSwitch from "../../components/LanguageSwitch";

export const metadata: Metadata = {
  title: "Veritas Forgeについて",
  description: "Veritas Forgeについて。",
  alternates: {
    canonical: "https://echo-r.veritasforge.net/ja/about",
    languages: {
      en: "https://echo-r.veritasforge.net/about",
      ja: "https://echo-r.veritasforge.net/ja/about",
    },
  },
};

export default function About() {
  return (
    <main className="min-h-screen bg-black p-20 text-white">
      <LanguageSwitch current="ja" enHref="/about" jaHref="/ja/about" />
      <h1 className="text-4xl font-black">Veritas Forgeについて</h1>
    </main>
  );
}
