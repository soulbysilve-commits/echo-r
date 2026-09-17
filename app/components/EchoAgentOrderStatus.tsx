"use client";

import { useEffect, useRef, useState } from "react";

type Locale = "ja" | "en";

type Status =
  | "checking"
  | "paid"
  | "preparing"
  | "downloadReady"
  | "downloadFailed"
  | "subscriptionPending"
  | "unpaid"
  | "error";

const copy = {
  ja: {
    checking: "決済を確認しています…",
    checkingBody: "Stripeに直接確認しています。ページのURLだけで購入完了とは判断していません。",
    paid: "お支払いを確認しました。",
    paidBody: "現時点では自動配布は行っていません。決済確認後、担当者がStripeの記録を確認したうえで、手動でご案内します。このページ自体が自動でECHO Agentを配布するものではありません。",
    preparing: "決済を確認しました。ECHO Agentのダウンロードを準備しています。",
    preparingBody: "少々お待ちください。準備が完了すると、ここにダウンロードボタンが表示されます。",
    downloadReady: "ダウンロードの準備ができました。",
    downloadReadyBody: "「ECHO Agentをダウンロード」を押すと、ライセンスファイルと本体の2つのファイルがダウンロードされます。両方とも同じフォルダに保存してください。",
    downloadButton: "ECHO Agentをダウンロード",
    downloadAgain: "もう一度ダウンロード",
    activationHeading: "アプリ内での認証方法",
    activationBody: "ECHO Agentを起動すると認証画面が表示されます。以下のメールアドレスとライセンスコードを入力して「認証する」を押してください。",
    activationEmailLabel: "購入時のメールアドレス",
    activationCodeLabel: "ライセンスコード",
    activationCodeCopy: "コピー",
    activationCodeCopied: "コピーしました",
    downloadFailed: "ダウンロードの準備に失敗しました。",
    downloadFailedBody: "お手数ですが、時間を置いて再度お試しいただくか、お問い合わせください。",
    subscriptionPending: "お支払いは完了しましたが、サブスクリプションの状態を確認中です。",
    subscriptionPendingBody: "Checkoutの完了だけでは継続課金の成立を意味しません。サブスクリプションが有効化されるまで少し時間がかかる場合があります。状況が変わらない場合はお問い合わせください。",
    unpaid: "お支払いが確認できませんでした。",
    unpaidBody: "決済が完了していないか、まだ反映されていない可能性があります。数分待っても状況が変わらない場合はお問い合わせください。",
    error: "確認中にエラーが発生しました。",
    errorBody: "時間を置いて再読み込みするか、お問い合わせください。",
    missing: "セッション情報が見つかりません。",
    contact: "お問い合わせ",
    home: "ECHO Agentページに戻る",
    testBanner: "テストモード（Stripe Sandbox） — 実際の請求は発生していません。",
  },
  en: {
    checking: "Confirming your payment…",
    checkingBody: "This checks directly with Stripe. The page URL alone is never treated as proof of purchase.",
    paid: "Payment confirmed.",
    paidBody: "ECHO Agent is not delivered automatically today. After confirming this order in Stripe's own records, our team will follow up by hand. This page does not automatically deliver ECHO Agent.",
    preparing: "Payment confirmed. Preparing your ECHO Agent download...",
    preparingBody: "This should only take a moment. A download button will appear here once it's ready.",
    downloadReady: "Your download is ready.",
    downloadReadyBody: "“Download ECHO Agent” starts two files: your license and the ECHO Agent package. Save both in the same folder.",
    downloadButton: "Download ECHO Agent",
    downloadAgain: "Download again",
    activationHeading: "Activating inside the app",
    activationBody: "When you launch ECHO Agent, you'll see an activation screen. Enter the email and activation code below, then press “Activate.”",
    activationEmailLabel: "Purchase email address",
    activationCodeLabel: "Activation code",
    activationCodeCopy: "Copy",
    activationCodeCopied: "Copied",
    downloadFailed: "We couldn't prepare your download.",
    downloadFailedBody: "Please try again in a moment, or contact us.",
    subscriptionPending: "Payment completed, but the subscription's status is still being confirmed.",
    subscriptionPendingBody: "Checkout completing alone doesn't mean the recurring subscription is active. This can take a moment to settle. If it doesn't change, please contact us.",
    unpaid: "Payment could not be confirmed.",
    unpaidBody: "The payment may be incomplete or not yet reflected. If this doesn't change after a few minutes, please contact us.",
    error: "Something went wrong while checking.",
    errorBody: "Please reload in a moment, or contact us.",
    missing: "No session information was found.",
    contact: "Contact us",
    home: "Back to ECHO Agent",
    testBanner: "TEST MODE (Stripe Sandbox) — no real charge was made.",
  },
} as const;

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes

export default function EchoAgentOrderStatus({ locale }: { locale: Locale }) {
  const c = copy[locale];
  const [status, setStatus] = useState<Status>("checking");
  const [email, setEmail] = useState<string | null>(null);
  const [isTestSession, setIsTestSession] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [activationCode, setActivationCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const pollCountRef = useRef(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    if (!sessionId) {
      setStatus("error");
      return;
    }
    sessionIdRef.current = sessionId;
    setIsTestSession(sessionId.startsWith("cs_test_"));

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = () => {
      fetch(`/api/echo-agent-order-status?session_id=${encodeURIComponent(sessionId)}`)
        .then(async (response) => {
          const data = await response.json().catch(() => null);
          if (cancelled) return;
          if (!response.ok || !data) {
            setStatus("error");
            return;
          }
          setEmail(data.customerEmail ?? null);

          if (!data.paid) {
            if (
              data.mode === "subscription" &&
              data.paymentStatus === "paid" &&
              data.subscriptionStatus &&
              data.subscriptionStatus !== "active" &&
              data.subscriptionStatus !== "trialing"
            ) {
              setStatus("subscriptionPending");
            } else {
              setStatus("unpaid");
            }
            return;
          }

          if (data.fulfillmentMode !== "automatic_download") {
            setStatus("paid");
            return;
          }

          if (data.entitlementStatus === "ready") {
            setStatus("downloadReady");
            fetch(`/api/echo-agent-activation-code?session_id=${encodeURIComponent(sessionId)}`)
              .then((res) => (res.ok ? res.json() : null))
              .then((codeData) => {
                if (!cancelled && codeData?.activationCode) setActivationCode(codeData.activationCode);
              })
              .catch(() => {
                // Non-fatal -- the download flow above still works
                // without this; the customer can also use the
                // secondary manual-license-file import path in the
                // app itself.
              });
            return;
          }
          if (data.entitlementStatus === "failed") {
            setStatus("downloadFailed");
            return;
          }

          // "pending" (or not yet recorded) -- the webhook may not have
          // landed yet. Keep polling for a bounded window rather than
          // failing immediately on a race between the redirect and the
          // webhook.
          pollCountRef.current += 1;
          if (pollCountRef.current > MAX_POLLS) {
            setStatus("downloadFailed");
            return;
          }
          setStatus("preparing");
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        });
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleDownload = async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || downloading) return;
    setDownloading(true);
    try {
      const response = await fetch("/api/echo-agent-download-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.license) {
        setStatus("downloadFailed");
        return;
      }

      // License first (small, inline JSON -> blob), then the encrypted
      // artifact stream, triggered within the same user gesture/click
      // handler so both downloads start together.
      const licenseBlob = new Blob([JSON.stringify(data.license)], { type: "application/json" });
      const licenseUrl = URL.createObjectURL(licenseBlob);
      const licenseLink = document.createElement("a");
      licenseLink.href = licenseUrl;
      licenseLink.download = "license.echo";
      document.body.appendChild(licenseLink);
      licenseLink.click();
      licenseLink.remove();
      setTimeout(() => URL.revokeObjectURL(licenseUrl), 10_000);

      const artifactLink = document.createElement("a");
      artifactLink.href = "/api/echo-agent-download";
      document.body.appendChild(artifactLink);
      artifactLink.click();
      artifactLink.remove();
    } catch {
      setStatus("downloadFailed");
    } finally {
      setDownloading(false);
    }
  };

  const local = (path: string) => (locale === "ja" ? `/ja${path}` : path);

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-3xl border border-white/10 bg-white/[0.04] p-8 md:p-10"
    >
      {isTestSession && (
        <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs font-bold uppercase tracking-wide text-amber-300">
          {c.testBanner}
        </div>
      )}
      <h1 className="text-2xl font-black md:text-3xl">
        {status === "checking" && c.checking}
        {status === "paid" && c.paid}
        {status === "preparing" && c.preparing}
        {(status === "downloadReady" || downloading) && c.downloadReady}
        {status === "downloadFailed" && c.downloadFailed}
        {status === "subscriptionPending" && c.subscriptionPending}
        {status === "unpaid" && c.unpaid}
        {status === "error" && c.error}
      </h1>
      <p className="mt-4 leading-8 text-gray-400">
        {status === "checking" && c.checkingBody}
        {status === "paid" && c.paidBody}
        {status === "preparing" && c.preparingBody}
        {status === "downloadReady" && c.downloadReadyBody}
        {status === "downloadFailed" && c.downloadFailedBody}
        {status === "subscriptionPending" && c.subscriptionPendingBody}
        {status === "unpaid" && c.unpaidBody}
        {status === "error" && c.errorBody}
      </p>
      {email && (status === "paid" || status === "downloadReady") && (
        <p className="mt-4 text-sm text-gray-500">{email}</p>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        {status === "downloadReady" && (
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            className="inline-flex items-center justify-center rounded-full bg-emerald-400 px-6 py-3 text-sm font-bold text-black transition hover:bg-emerald-300 disabled:opacity-60"
          >
            {downloading ? "..." : c.downloadButton}
          </button>
        )}
      </div>
      {status === "downloadReady" && activationCode && (
        <div className="mt-8 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-6">
          <h2 className="text-base font-bold">{c.activationHeading}</h2>
          <p className="mt-2 text-sm leading-7 text-gray-400">{c.activationBody}</p>
          {email && (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">{c.activationEmailLabel}</div>
              <div className="mt-1 font-mono text-sm">{email}</div>
            </div>
          )}
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">{c.activationCodeLabel}</div>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <code className="rounded-lg bg-black/40 px-3 py-2 font-mono text-sm tracking-wide">{activationCode}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(activationCode).then(() => {
                    setCodeCopied(true);
                    setTimeout(() => setCodeCopied(false), 2000);
                  });
                }}
                className="rounded-full border border-white/20 px-4 py-1.5 text-xs font-bold hover:bg-white/10"
              >
                {codeCopied ? c.activationCodeCopied : c.activationCodeCopy}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        <a
          href="mailto:soulbysilver@veritasforge.net"
          className="inline-flex items-center justify-center rounded-full bg-blue-500 px-6 py-3 text-sm font-bold text-black transition hover:bg-blue-400"
        >
          {c.contact}
        </a>
        <a
          href={local("/echo-agent")}
          className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 text-sm font-bold hover:bg-white/10"
        >
          {c.home}
        </a>
      </div>
    </div>
  );
}
