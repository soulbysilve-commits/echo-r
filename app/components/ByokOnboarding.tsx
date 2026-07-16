import Link from "next/link";

const steps = [
  {
    number: "01",
    title: "Create Your API Accounts",
    text: "Create API accounts with providers such as OpenAI, Anthropic, and Google under your own name or organization.",
  },
  {
    number: "02",
    title: "Set Usage Limits",
    text: "Configure monthly spending limits and billing alerts directly with each API provider.",
  },
  {
    number: "03",
    title: "Register Keys Securely",
    text: "Enter your API keys directly into your dedicated private server environment.",
  },
  {
    number: "04",
    title: "Verify the Connection",
    text: "Confirm connection status and available models without displaying or logging secret values.",
  },
];

const protections = [
  "API keys are never sent through Discord, LINE, or email",
  "Each customer receives separate keys and isolated storage",
  "Secret files are excluded from Git, logs, and public data",
  "Customers can revoke their own API keys at any time",
];

export default function ByokOnboarding() {
  return (
    <section
      id="byok"
      className="relative mx-auto max-w-7xl overflow-hidden px-6 py-24"
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-16 h-72 w-72 -translate-x-1/2 rounded-full bg-blue-600/15 blur-3xl" />
      </div>

      <div className="relative rounded-3xl border border-white/10 bg-white/[0.035] p-8 backdrop-blur md:p-12">
        <div className="max-w-3xl">
          <p className="mb-4 text-sm font-semibold tracking-[0.24em] text-blue-400">
            BRING YOUR OWN KEY
          </p>

          <h2 className="text-3xl font-black tracking-tight text-white md:text-5xl">
            You Stay in Control of API Costs
          </h2>

          <p className="mt-6 text-base leading-8 text-gray-300 md:text-lg">
            The ECHO-R / Veritas Forge service fee covers personality design,
            memory infrastructure, Discord integration, maintenance, and
            operational support. External AI API usage is billed directly to
            your own provider accounts.
          </p>
        </div>

        <div className="mt-10 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-5">
          <p className="font-bold text-amber-200">
            API keys are never entered on this public website
          </p>

          <p className="mt-2 text-sm leading-7 text-gray-300">
            During onboarding, customers enter their keys directly into a
            dedicated private server environment. Veritas Forge does not accept
            API keys through public forms, Discord, LINE, or email.
          </p>
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((step) => (
            <article
              key={step.number}
              className="rounded-2xl border border-white/10 bg-black/30 p-6"
            >
              <p className="text-sm font-black tracking-[0.2em] text-blue-400">
                {step.number}
              </p>

              <h3 className="mt-4 text-xl font-bold text-white">
                {step.title}
              </h3>

              <p className="mt-3 text-sm leading-7 text-gray-400">
                {step.text}
              </p>
            </article>
          ))}
        </div>

        <div className="mt-12 grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-7">
            <h3 className="text-2xl font-bold text-white">
              What BYOK Separates
            </h3>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 p-5">
                <p className="text-sm text-gray-400">
                  Veritas Forge Service Fee
                </p>

                <p className="mt-2 font-bold text-white">
                  Personality, Memory, Integration, and Maintenance
                </p>
              </div>

              <div className="rounded-xl border border-white/10 p-5">
                <p className="text-sm text-gray-400">AI API Usage</p>

                <p className="mt-2 font-bold text-white">
                  Paid Directly by the Customer to Each API Provider
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-7">
            <h3 className="text-xl font-bold text-white">
              Security Principles
            </h3>

            <ul className="mt-5 space-y-4">
              {protections.map((item) => (
                <li
                  key={item}
                  className="flex gap-3 text-sm leading-6 text-gray-300"
                >
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-4 sm:flex-row">
          <Link
            href="/contact"
            className="rounded-xl bg-blue-600 px-7 py-4 text-center font-bold text-white transition hover:bg-blue-500"
          >
            Contact Us About Deployment
          </Link>

          <Link
            href="/echo-r"
            className="rounded-xl border border-white/15 px-7 py-4 text-center font-bold text-white transition hover:bg-white/10"
          >
            Explore ECHO-R
          </Link>
        </div>
      </div>
    </section>
  );
}
