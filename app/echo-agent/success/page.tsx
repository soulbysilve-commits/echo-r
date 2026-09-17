import LanguageSwitch from "../../components/LanguageSwitch";
import EchoAgentOrderStatus from "../../components/EchoAgentOrderStatus";

export const metadata = { robots: { index: false, follow: false } };

export default function Page() {
  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <LanguageSwitch current="en" enHref="/echo-agent/success" jaHref="/ja/echo-agent/success" />
      <section className="mx-auto max-w-2xl">
        <EchoAgentOrderStatus locale="en" />
      </section>
    </main>
  );
}
