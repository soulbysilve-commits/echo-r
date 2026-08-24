"use client";

import { FormEvent, useState } from "react";

export default function EarlyAccessForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      setStatus("error");
      setMessage("メールアドレスを入力してください。");
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const response = await fetch("/api/echo-early-access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: normalizedEmail,
          source: "echo-app-early-access",
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.error || "現在、登録を完了できませんでした。"
        );
      }

      setStatus("success");
      setMessage(
        "事前登録ありがとうございます。Early Accessの準備ができ次第、順次ご案内します。"
      );
      setEmail("");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "現在、登録を完了できませんでした。"
      );
    }
  }

  return (
    <div className="w-full">
      {status === "success" ? (
        <div
          role="status"
          className="rounded-2xl border border-blue-400/30 bg-blue-400/10 p-5 text-sm leading-7 text-blue-100"
        >
          {message}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <label htmlFor="early-access-email" className="sr-only">
            メールアドレス
          </label>

          <input
            id="early-access-email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-base text-white outline-none transition placeholder:text-gray-600 focus:border-blue-400/70 focus:bg-white/[0.06]"
          />

          <button
            type="submit"
            disabled={status === "loading"}
            className="w-full rounded-2xl bg-white px-5 py-4 font-bold text-black transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === "loading"
              ? "登録中..."
              : "Early Accessに登録"}
          </button>

          {status === "error" && (
            <p
              role="alert"
              className="text-sm leading-6 text-red-300"
            >
              {message}
            </p>
          )}
        </form>
      )}

      <p className="mt-4 text-center text-xs text-gray-500">
        iPhone版から順次β公開予定
      </p>
    </div>
  );
}
