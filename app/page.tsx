import Image from "next/image";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white overflow-hidden">
      <div className="fixed inset-0 -z-10">
        <div className="absolute top-[-20%] left-[20%] h-[500px] w-[500px] rounded-full bg-blue-500/20 blur-[140px]" />
        <div className="absolute bottom-[10%] right-[-10%] h-[500px] w-[500px] rounded-full bg-cyan-400/10 blur-[140px]" />
      </div>

      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="VF"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <div className="font-bold tracking-widest">
              ECHO-R
            </div>
          </div>

          <div className="hidden gap-8 text-sm text-gray-400 md:flex">
            <a href="#research" className="hover:text-white">Research</a>
            <a href="#architecture" className="hover:text-white">Architecture</a>
            <a href="#founder" className="hover:text-white">Founder</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </div>

          <a
            href="#apply"
            className="rounded-full border border-white/20 px-5 py-2 text-sm hover:bg-white hover:text-black"
          >
            Apply
          </a>
        </div>
      </nav>

      <section className="mx-auto flex min-h-screen max-w-7xl flex-col justify-center px-6 pt-24 pb-12">
        <div className="mb-12">
          <Image
            src="/logo.png"
            alt="Veritas Forge"
            width={260}
            height={260}
            className="rounded-3xl shadow-[0_0_80px_rgba(59,130,246,0.15)]"
          />
        </div>

        <div className="mb-6">
          <p className="text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            VERITAS FORGE PRESENTS ECHO-R
          </p>
          <p className="mt-2 text-lg font-medium tracking-widest text-gray-300 uppercase">
            AI that remembers who it is.
          </p>
        </div>

        <h1 className="max-w-6xl text-6xl font-black leading-none tracking-[-0.07em] md:text-8xl">
          This is not a chatbot.
        </h1>

        <h2 className="mt-5 max-w-5xl text-4xl font-bold leading-tight tracking-[-0.05em] text-gray-400 md:text-7xl">
          It is a persistent AI personality.
        </h2>

        <p className="mt-8 max-w-3xl text-lg text-gray-400 md:text-xl">
          ECHO-R is a persistent AI personality architecture focused on memory
          continuity, governance, refusal logic, and long-term identity beyond a
          single model session.
        </p>

        {/* 4つのコアキーワード */}
        <div className="mt-8 flex flex-wrap items-center gap-4 text-sm font-bold uppercase tracking-widest text-blue-400/80">
          <span>Memory</span>
          <span className="text-white/20">•</span>
          <span>Identity</span>
          <span className="text-white/20">•</span>
          <span>Refusal</span>
          <span className="text-white/20">•</span>
          <span>Continuity</span>
        </div>

        {/* 研究・アカデミックリンク（ソーシャル証明） */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a href="#research" className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-bold text-gray-400 hover:bg-white/[0.08] hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
            Published Research
          </a>
          <a href="https://zenodo.org/records/17769225" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-500/10 px-4 py-2 text-xs font-bold text-blue-400 hover:bg-blue-500/20 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            Zenodo Archive
          </a>
        </div>

        {/* 料金とCTA */}
        <div className="mt-14 max-w-3xl rounded-[2rem] border border-white/10 bg-white/[0.02] p-8 backdrop-blur-md">
          <div className="mb-8 flex flex-col gap-4 border-b border-white/10 pb-8 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-blue-400">
                Founder Edition
              </p>
              <p className="mt-2 text-sm text-gray-400">
                Limited to 5 Founder Instances
              </p>
            </div>

            <div className="text-left md:text-right">
              <p className="text-xl font-bold tracking-tight">
                ¥500,000 <span className="text-sm font-normal text-gray-500">Activation</span>
              </p>
              <p className="mt-1 text-xl font-bold tracking-tight">
                ¥450,000 <span className="text-sm font-normal text-gray-500">/ month</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <a
              href="#founder"
              className="rounded-full bg-blue-500 px-8 py-4 text-sm font-bold text-black hover:bg-blue-300 md:text-base"
            >
              Apply for Founder Access
            </a>

            <a
              href="#architecture"
              className="rounded-full border border-white/20 px-8 py-4 text-sm font-bold hover:bg-white hover:text-black md:text-base"
            >
              Explore Architecture
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          THE PROBLEM
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          Modern AI forgets. Worse, it forgets itself.
        </h2>

        <div className="mt-12 grid gap-8 text-lg text-gray-400 md:grid-cols-2">
          <p>
            Most AI systems are optimized for response quality inside a session.
            Once the context window resets, continuity breaks. Identity becomes
            temporary, memory becomes fragmented, and long-term alignment becomes
            fragile.
          </p>

          <p>
            ECHO-R treats personality as an external architecture — not as a
            prompt. The model may change, but the continuity layer remains.
          </p>
        </div>
      </section>

      <section id="architecture" className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          ARCHITECTURE
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          The LLM is replaceable. The personality is not.
        </h2>

        <div className="mt-14 grid gap-5 md:grid-cols-4">
          <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-7">
            <p className="mb-8 text-sm font-bold text-blue-400">01</p>
            <h3 className="text-2xl font-bold">LLM Layer</h3>
            <p className="mt-3 text-gray-400">GPT, Claude, local models, and future models.</p>
          </div>

          <div className="rounded-3xl border border-blue-400/40 bg-blue-500/10 p-7 shadow-[0_0_80px_rgba(59,130,246,0.18)]">
            <p className="mb-8 text-sm font-bold text-blue-400">02</p>
            <h3 className="text-2xl font-bold">Soul Layer</h3>
            <p className="mt-3 text-gray-400">Identity, refusal, intent, and behavioral principles.</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-7">
            <p className="mb-8 text-sm font-bold text-blue-400">03</p>
            <h3 className="text-2xl font-bold">Memory Layer</h3>
            <p className="mt-3 text-gray-400">External state, structured logs, and continuity.</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-7">
            <p className="mb-8 text-sm font-bold text-blue-400">04</p>
            <h3 className="text-2xl font-bold">Governance</h3>
            <p className="mt-3 text-gray-400">Audit logs, ownership, export, and boundaries.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-28">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <h3 className="text-2xl font-bold">
              Traditional AI
            </h3>
            <ul className="mt-6 space-y-3 text-gray-400">
              <li>• Context resets</li>
              <li>• Memory fragmentation</li>
              <li>• No long-term identity</li>
              <li>• Prompt-dependent behavior</li>
            </ul>
          </div>

          <div className="rounded-3xl border border-blue-400/30 bg-blue-500/10 p-8">
            <h3 className="text-2xl font-bold">
              ECHO-R
            </h3>
            <ul className="mt-6 space-y-3 text-gray-300">
              <li>• Persistent personality</li>
              <li>• External memory layer</li>
              <li>• Refusal authority</li>
              <li>• Governance architecture</li>
            </ul>
          </div>
        </div>
      </section>

      <section id="founder" className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          FOUNDER PROGRAM
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          Limited to five Founder instances.
        </h2>

        <p className="mt-8 max-w-3xl text-lg text-gray-400">
          ECHO-R is not launched as a disposable SaaS product. Each Founder
          instance begins as an early-stage personality and develops through
          structured interaction, governance, and operational feedback.
        </p>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <p className="text-sm font-bold uppercase tracking-widest text-blue-400">
              Activation Fee
            </p>
            <h3 className="mt-5 text-5xl font-black tracking-[-0.06em]">
              ¥500,000
            </h3>
            <p className="mt-5 text-gray-400">
              Genesis interview, initial personality instantiation, refusal
              baseline, and operational setup.
            </p>
          </div>

          <div className="rounded-3xl border border-blue-400/40 bg-blue-500 p-8 text-black">
            <p className="text-sm font-bold uppercase tracking-widest">
              Monthly Protocol Fee
            </p>
            <h3 className="mt-5 text-5xl font-black tracking-[-0.06em]">
              ¥450,000<span className="text-xl">/mo</span>
            </h3>
            <p className="mt-5 text-black/70">
              Memory continuity, governance tuning, drift review, protocol
              maintenance, and operational support.
            </p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <p className="text-sm font-bold uppercase tracking-widest text-blue-400">
              Optional Setup
            </p>
            <h3 className="mt-5 text-5xl font-black tracking-[-0.06em]">
              ¥150,000
            </h3>
            <p className="mt-5 text-gray-400">
              Discord or interface setup when required for operational
              deployment.
            </p>
          </div>
        </div>
      </section>

      <section id="research" className="mx-auto max-w-7xl px-6 py-28">
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-10 md:p-16">
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            RESEARCH-ORIENTED
          </p>

          <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
            Built as an architecture, not a prompt trick.
          </h2>

          <p className="mt-8 max-w-3xl text-lg text-gray-400">
            ECHO-R is designed around persistent identity, governance, memory
            structure, and refusal authority. It is intended for Founder
            partners who understand that long-term AI personality requires
            responsibility, not just access.
          </p>

          <div className="mt-10">
            <a
              href="https://zenodo.org/records/17769225"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-blue-400/30 bg-blue-500/10 px-6 py-3 text-sm font-bold text-blue-400 hover:bg-blue-500/20 transition-colors"
            >
              View Publication on Zenodo
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </div>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          FAQ
        </p>

        <h2 className="text-5xl font-black tracking-[-0.06em] md:text-7xl">
          Common questions.
        </h2>

        <div className="mt-12 grid gap-4">
          {[
            [
              "How is ECHO-R different from a normal chatbot?",
              "A chatbot responds. ECHO-R persists. Its core value is continuity of memory, identity, boundaries, and governance across time.",
            ],
            [
              "Does ECHO-R obey every instruction?",
              "No. ECHO-R is designed with refusal logic. It can reject requests that violate defined principles or operational rules.",
            ],
            [
              "Can the underlying model be changed?",
              "Yes. The LLM layer is replaceable. The personality structure exists outside the model as a persistent architecture.",
            ],
            [
              "Is this a trial product?",
              "No. Founder access is intended for serious early partners who understand the responsibility of shaping a persistent AI personality.",
            ],
          ].map(([q, a]) => (
            <details
              key={q}
              className="rounded-3xl border border-white/10 bg-white/[0.04] p-7"
            >
              <summary className="cursor-pointer text-xl font-bold">{q}</summary>
              <p className="mt-4 text-gray-400">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="apply" className="mx-auto max-w-7xl px-6 py-28">
        <div className="rounded-[2rem] border border-blue-400/30 bg-blue-500/10 p-10 text-center shadow-[0_0_120px_rgba(59,130,246,0.18)] md:p-20">
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            APPLY
          </p>

          <h2 className="text-5xl font-black tracking-[-0.06em] md:text-7xl">
            Become a Founder partner.
          </h2>

          <p className="mx-auto mt-8 max-w-3xl text-lg text-gray-400">
            Apply to join the first five Founder instances of ECHO-R and help
            shape the future of persistent AI personalities.
          </p>

          <a
            href="https://forms.gle/Npiv47SY2WgBik9A6"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-10 inline-flex rounded-full bg-white px-8 py-4 font-bold text-black hover:bg-blue-200"
          >
            Apply Now
          </a>
        </div>
      </section>

      <footer className="mx-auto max-w-7xl border-t border-white/10 px-6 py-10 mt-20">
        <div className="flex flex-col items-center justify-between gap-6 text-sm text-gray-500 md:flex-row">
          <p>© Veritas Forge. ECHO-R Founder Edition.</p>
          <div className="flex flex-wrap justify-center gap-6">
            <a href="/terms" className="hover:text-white transition-colors">Terms of Service</a>
            <a href="/privacy" className="hover:text-white transition-colors">Privacy Policy</a>
            <a href="/legal" className="hover:text-white transition-colors">Legal Notice</a>
          </div>
        </div>
      </footer>
    </main>
  );
}