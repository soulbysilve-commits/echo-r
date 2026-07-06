export default function contact() {
    return (
        <main className="min-h-screen bg-black px-6 py-32 text-white">
            <section className="mx-auto max-w-3xl">
                <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
                    contact
                </p>

                <h1 className="text-5xl font-black tracking-tight md:text-7xl">
                    Get in touch.
                </h1>

                <p className="mt-6 text-gray-400">
                    For ECHO-R Founder applications, research inquiries, or collaboration,
                    contact Veritas Forge directly.
                </p>

                <form
                    action="mailto:soulbysilver@veritasforge.net"
                    method="post"
                    encType="text/plain"
                    className="mt-10 space-y-5"
                >
                    <input
                        name="name"
                        placeholder="Your name"
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-white outline-none transition-colors focus:border-blue-500"
                    />

                    <input
                        name="email"
                        type="email"
                        placeholder="Your email"
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-white outline-none transition-colors focus:border-blue-500"
                    />

                    <textarea
                        name="message"
                        placeholder="Message"
                        rows={7}
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-white outline-none transition-colors focus:border-blue-500"
                    />

                    <button
                        type="submit"
                        className="rounded-xl bg-blue-600 px-8 py-4 font-bold transition-colors hover:bg-blue-500"
                    >
                        Send Message
                    </button>
                </form>

                <p className="mt-8 text-sm text-gray-500">
                    Email: soulbysilver@veritasforge.net
                </p>
            </section>
        </main>
    );
}