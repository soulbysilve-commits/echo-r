import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const EMAIL_PATTERN =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const email =
      typeof body?.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json(
        {
          error: "有効なメールアドレスを入力してください。",
        },
        { status: 400 }
      );
    }

    const webhookUrl =
      process.env.ECHO_EARLY_ACCESS_WEBHOOK_URL;

    if (!webhookUrl) {
      console.error(
        "ECHO_EARLY_ACCESS_WEBHOOK_URL is not configured."
      );

      return NextResponse.json(
        {
          error:
            "現在、Early Access登録受付の準備中です。しばらくしてからもう一度お試しください。",
        },
        { status: 503 }
      );
    }

    const forwardedFor =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      undefined;

    const result = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        source: "echo-app-early-access",
        createdAt: new Date().toISOString(),
        userAgent:
          request.headers.get("user-agent") || undefined,
        ip: forwardedFor,
      }),
    });

    if (!result.ok) {
      console.error(
        "Early Access webhook failed:",
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

    return NextResponse.json({
      ok: true,
    });
  } catch (error) {
    console.error("Early Access registration error:", error);

    return NextResponse.json(
      {
        error:
          "現在、登録を完了できませんでした。時間を置いてもう一度お試しください。",
      },
      { status: 500 }
    );
  }
}
