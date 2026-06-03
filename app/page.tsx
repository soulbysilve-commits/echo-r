import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white overflow-hidden">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/logo.png" alt="Veritas Forge" width={36} height={36} />
            <span className="font-bold tracking-widest">VERITAS FORGE</span>
          </Link>

          <div className="flex gap-6 text-sm text-gray-400">
            <Link href="/" className="hover:text-white">HOME</Link>
            <Link href="/echo-r" className="hover:text-white">ECHO-R</Link>
            <Link href="/contact" className="hover:text-white">Contact</Link>
            <Link href="/about" className="hover:text-white">About Us</Link>
          </div>
        </div>
      </nav>

      <section className="mx-auto flex min-h-screen max-w-7xl flex-col justify-center px-6 pt-28">
        <Image
          src="/logo.png"
          alt="Veritas Forge"
          width={260}
          height={260}
          className="mb-12 rounded-3xl shadow-[0_0_80px_rgba(59,130,246,0.18)]"
        />

        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          VERITAS FORGE
        </p>

        <h1 className="max-w-5xl text-6xl font-black leading-none tracking-[-0.07em] md:text-8xl">
          Building Persistent AI Personalities.
        </h1>

        <p className="mt-8 max-w-3xl text-xl text-gray-400">
          Veritas Forge is an independent AI research and development initiative
          focused on memory continuity, identity persistence, refusal authority,
          and governance architecture.
        </p>

        <div className="mt-12 flex flex-wrap gap-4">
          <Link
            href="/echo-r"
            className="rounded-full bg-blue-500 px-8 py-4 font-bold text-black hover:bg-blue-300"
          >
            Explore ECHO-R
          </Link>

          <Link
            href="/contact"
            className="rounded-full border border-white/20 px-8 py-4 font-bold hover:bg-white hover:text-black"
          >
            Contact
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          NEWS
        </p>

        <h2 className="text-5xl font-black tracking-[-0.06em] md:text-7xl">
          Latest Updates
        </h2>

        <div className="mt-12 grid gap-5">
          {[
            ["2026/06/03", "ECHO-R official website released."],
            ["2026/06/03", "Founder applications are now open."],
            ["2026/06/03", "ECHO-R research archive is available on Zenodo."],
          ].map(([date, title]) => (
            <div
              key={title}
              className="rounded-3xl border border-white/10 bg-white/[0.04] p-7"
            >
              <p className="text-sm font-bold text-blue-400">{date}</p>
              <p className="mt-2 text-xl font-bold">{title}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          ECHO-R
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          This is not a chatbot.
        </h2>

        <p className="mt-8 max-w-3xl text-lg text-gray-400">
          ECHO-R is a persistent AI personality architecture focused on memory,
          identity, refusal, and continuity.
        </p>

        <Link
          href="/echo-r"
          className="mt-10 inline-flex rounded-full bg-white px-8 py-4 font-bold text-black hover:bg-blue-200"
        >
          View ECHO-R
        </Link>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          ABOUT US
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          Independent AI architecture research.
        </h2>

        <p className="mt-8 max-w-3xl text-lg text-gray-400">
          Veritas Forge develops AI personality systems, continuity protocols,
          memory structures, and governance frameworks for long-term AI identity.
        </p>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28">
        <div className="rounded-[2rem] border border-blue-400/30 bg-blue-500/10 p-10 text-center md:p-20">
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            CONTACT
          </p>

          <h2 className="text-5xl font-black tracking-[-0.06em] md:text-7xl">
            Get in touch.
          </h2>

          <p className="mt-8 text-gray-400">
            soulbysilver@veritasforge.net
          </p>
        </div>
      </section>

      <footer className="mx-auto max-w-7xl border-t border-white/10 px-6 py-10 text-sm text-gray-500">
        <div className="flex flex-col justify-between gap-6 md:flex-row">
          <p>© Veritas Forge.</p>

          <div className="flex gap-6">
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/legal" className="hover:text-white">Legal</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}