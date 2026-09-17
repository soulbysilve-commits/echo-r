import Link from "next/link";
import LanguageSwitch from "../../components/LanguageSwitch";

export const metadata = { robots: { index: false, follow: false } };

export default function Page() {
  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <LanguageSwitch current="en" enHref="/echo-agent/cancel" jaHref="/ja/echo-agent/cancel" />
      <section className="mx-auto max-w-2xl rounded-3xl border border-white/10 bg-white/[0.04] p-8 md:p-10">
        <h1 className="text-2xl font-black md:text-3xl">Checkout was canceled.</h1>
        <p className="mt-4 leading-8 text-gray-400">
          No payment was made. You can return to the ECHO Agent page whenever you're ready.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/echo-agent"
            className="inline-flex items-center justify-center rounded-full bg-blue-500 px-6 py-3 text-sm font-bold text-black transition hover:bg-blue-400"
          >
            Back to ECHO Agent
          </Link>
        </div>
      </section>
    </main>
  );
}
