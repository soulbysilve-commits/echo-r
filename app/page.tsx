import Image from "next/image";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      {/* Header */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">

          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="Veritas Forge"
              width={36}
              height={36}
            />
            <span className="font-bold tracking-widest">
              VERITAS FORGE
            </span>
          </div>

          <div className="flex gap-8 text-sm">
            <a href="/">HOME</a>
            <a href="/echo-r">ECHO-R</a>
            <a href="/Contact">Contact</a>
            <a href="/About">About Us</a>
          </div>

        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-7xl px-6 pt-32">
        <h1 className="text-7xl font-black tracking-tight">
          Veritas Forge
        </h1>

        <p className="mt-6 max-w-3xl text-xl text-gray-400">
          AI Personality Research • Memory Continuity • Governance Systems
        </p>

        <div className="mt-10 flex gap-4">
          <a
            href="/echo-r"
            className="rounded-xl bg-blue-600 px-6 py-3 font-bold hover:bg-blue-500"
          >
            Explore ECHO-R
          </a>

          <a
            href="https://forms.gle/yo2GDv3oGUpUH4Uy8"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl border border-white/20 px-6 py-3 font-bold hover:bg-white/10"
          >
            Apply Founder
          </a>
        </div>
      </section>

      {/* What We Build */}
      <section className="mx-auto max-w-7xl px-6 py-20">

        <h2 className="mb-10 text-4xl font-bold">
          What We Build
        </h2>

        <div className="grid gap-6 md:grid-cols-3">

          <div className="rounded-2xl border border-white/10 p-6">
            <h3 className="text-2xl font-bold">
              ECHO-R
            </h3>

            <p className="mt-3 text-gray-400">
              Persistent AI Personality Architecture
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 p-6">
            <h3 className="text-2xl font-bold">
              Lyla
            </h3>

            <p className="mt-3 text-gray-400">
              Mental Health Support AI
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 p-6">
            <h3 className="text-2xl font-bold">
              Research
            </h3>

            <p className="mt-3 text-gray-400">
              Memory Continuity & Governance
            </p>
          </div>

        </div>

      </section>

      {/* News */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <h2 className="mb-8 text-4xl font-bold">
          Latest News
        </h2>

        <div className="space-y-4">

          <div className="rounded-2xl border border-white/10 p-6">
            <p className="text-blue-400">
              2026-06-03
            </p>
            <p className="mt-2">
              ECHO-R Official Website Released
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 p-6">
            <p className="text-blue-400">
              2026-06-03
            </p>
            <p className="mt-2">
              Founder Applications Open
            </p>
          </div>

        </div>
      </section>
    </main>
  );
}