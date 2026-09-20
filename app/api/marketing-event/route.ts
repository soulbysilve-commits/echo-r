import { NextRequest, NextResponse } from "next/server";
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { validateEvent, type MarketingEventInput } from "@/lib/analyticsEvents";

// Force the Node.js runtime (not Edge) — this route uses `fs`.
export const runtime = "nodejs";

// KNOWN LIMITATION (see docs/marketing/AUTONOMOUS_MARKETING_AUDIT.md):
// this writes to a local file, which is durable in development but NOT
// durable on Vercel's serverless runtime (each invocation gets an ephemeral
// filesystem). Shipping durable production analytics needs a real sink —
// a database or a hosted analytics provider — which needs its own
// credentials and is therefore reported as AUTH_REQUIRED, not built here.
// The validation/redaction contract above this line is what actually
// matters for privacy and is fully real regardless of the sink.
const EVENTS_FILE = path.join(process.cwd(), "var", "marketing", "site-events.jsonl");

export async function POST(request: NextRequest) {
  let body: MarketingEventInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const result = validateEvent(body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  try {
    mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    appendFileSync(EVENTS_FILE, JSON.stringify(result.event) + "\n");
  } catch {
    // Never fail the page for an analytics write failure.
    return NextResponse.json({ ok: true, stored: false });
  }

  return NextResponse.json({ ok: true, stored: true });
}
