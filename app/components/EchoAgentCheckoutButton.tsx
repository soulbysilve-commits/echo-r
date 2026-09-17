"use client";

import { useState } from "react";

type Locale = "ja" | "en";

const copy = {
  ja: { idle: "ECHO Agentを購入", loading: "決済ページへ移動しています…", error: "決済ページを開けませんでした。時間を置いてお試しください。" },
  en: { idle: "Purchase ECHO Agent", loading: "Redirecting to checkout…", error: "Could not open checkout. Please try again shortly." },
} as const;

// Deliberately different wording from `copy` above -- this must never
// be mistaken for the real purchase CTA. Only rendered at all when
// isStripeTestCheckoutEnabled() is true (Preview/development, an
// explicit opt-in flag, and a sk_test_ key -- see lib/stripe.ts),
// which the checkout route itself also re-checks server-side.
const testCopy = {
  ja: { idle: "テスト購入（Stripeテストモード）", loading: "テスト決済ページへ移動しています…", error: "テスト決済ページを開けませんでした。時間を置いてお試しください。" },
  en: { idle: "Test purchase ECHO Agent (Stripe test mode)", loading: "Redirecting to test checkout…", error: "Could not open test checkout. Please try again shortly." },
} as const;

export default function EchoAgentCheckoutButton({ locale, className, testMode = false }: { locale: Locale; className: string; testMode?: boolean }) {
  const c = testMode ? testCopy[locale] : copy[locale];
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  async function handleClick() {
    setStatus("loading");
    try {
      const response = await fetch("/api/echo-agent-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) {
        setStatus("error");
        return;
      }
      window.location.href = data.url;
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-2">
      <button type="button" onClick={handleClick} disabled={status === "loading"} className={`${className} disabled:cursor-not-allowed disabled:opacity-60`}>
        {status === "loading" ? c.loading : c.idle}
      </button>
      {status === "error" && (
        <p role="alert" className="text-sm text-red-300">
          {c.error}
        </p>
      )}
    </div>
  );
}
