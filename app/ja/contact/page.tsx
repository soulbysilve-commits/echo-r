import type { Metadata } from "next";
import LanguageSwitch from "../../components/LanguageSwitch";

export const metadata: Metadata = {
  title: "お問い合わせ | Veritas Forge",
  description: "ECHO-R Founder応募、研究、共同検証、協業に関するVeritas Forgeへのお問い合わせ。",
  alternates: {
    canonical: "https://echo-r.veritasforge.net/ja/contact",
    languages: {
      en: "https://echo-r.veritasforge.net/contact",
      ja: "https://echo-r.veritasforge.net/ja/contact",
    },
  },
};

export default function Contact() {
  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <LanguageSwitch current="ja" enHref="/contact" jaHref="/ja/contact" />
      <section className="mx-auto max-w-3xl">
        <p className="mb-4 text-sm font-bold tracking-[0.35em] text-blue-400">
          お問い合わせ
        </p>

        <h1 className="text-5xl font-black tracking-tight md:text-7xl">
          Veritas Forgeへ相談する。
        </h1>

        <p className="mt-6 text-gray-400">
          ECHO-R Founderへの応募、研究に関するお問い合わせ、共同検証、協業については、Veritas Forgeへ直接ご連絡ください。
        </p>

        <form
          action="mailto:soulbysilver@veritasforge.net"
          method="post"
          encType="text/plain"
          className="mt-10 space-y-5"
        >
          <input
            name="name"
            placeholder="お名前"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-white outline-none transition-colors focus:border-blue-500"
          />

          <input
            name="email"
            type="email"
            placeholder="メールアドレス"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-white outline-none transition-colors focus:border-blue-500"
          />

          <textarea
            name="message"
            placeholder="お問い合わせ内容"
            rows={7}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-white outline-none transition-colors focus:border-blue-500"
          />

          <button
            type="submit"
            className="rounded-xl bg-blue-600 px-8 py-4 font-bold transition-colors hover:bg-blue-500"
          >
            メッセージを送る
          </button>
        </form>

        <p className="mt-8 text-sm text-gray-500">
          メール: soulbysilver@veritasforge.net
        </p>
      </section>
    </main>
  );
}
