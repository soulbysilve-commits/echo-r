import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const email =
      typeof body?.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json(
        { error: "有効なメールアドレスを入力してください。" },
        { status: 400 }
      );
    }

    const webhookUrl =
      process.env.ECHO_EARLY_ACCESS_WEBHOOK_URL;

    const webhookSecret =
      process.env.ECHO_EARLY_ACCESS_WEBHOOK_SECRET;

    if (!webhookUrl || !webhookSecret) {
      console.error(
        "Early Access webhook environment variables are not configured."
      );

      return NextResponse.json(
        {
          error:
            "現在、Early Access登録受付の準備中です。",
          diagnostic: {
            webhookUrlConfigured: Boolean(webhookUrl),
            webhookSecretConfigured: Boolean(webhookSecret),
          },
        },
        { status: 503 }
      );
    }

    const result = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        source: "echo-app-early-access",
        createdAt: new Date().toISOString(),
        secret: webhookSecret,
      }),
      redirect: "follow",
    });

    if (!result.ok) {
      console.error(
        "Early Access webhook HTTP error:",
        result.status
      );

      return NextResponse.json(
        {
          error:
            "現在、登録を完了できませんでした。時間を置いてもう一度お試しください。",
        },
        { status: 502 }
      );
    }

    const webhookResult =
      await result.json().catch(() => null);

    if (!webhookResult || webhookResult.ok !== true) {
      console.error(
        "Early Access webhook rejected request:",
        webhookResult
      );

      return NextResponse.json(
        {
          error:
            "現在、登録を完了できませんでした。時間を置いてもう一度お試しください。",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      duplicate: webhookResult.duplicate === true,
    });
  } catch (error) {
    console.error(
      "Early Access registration error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "現在、登録を完了できませんでした。時間を置いてもう一度お試しください。",
      },
      { status: 500 }
    );
  }
}
