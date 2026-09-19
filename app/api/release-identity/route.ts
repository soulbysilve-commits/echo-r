import { NextResponse } from "next/server";
import { isStripeLiveSalesEnabled } from "../../../lib/stripe";
import { buildReleaseIdentity } from "../../../lib/releaseIdentity";

/**
 * Read-only identity of THIS running deployment (source revision,
 * Vercel deployment id, environment, and the derived boolean of the
 * live-sales gate). Consumed by veritas-release-orchestrator's
 * post-validation to prove the live Production alias serves the exact
 * candidate revision. See lib/releaseIdentity.ts for where each value
 * comes from and why no secret can appear here.
 *
 * Never cached: a stale answer would defeat the purpose. Reads no
 * request data, mutates nothing, calls no external service.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Each process.env.X below is a literal property access on purpose --
  // next.config.ts's `env` only inlines the build-time revision into
  // literal `process.env.VERITAS_RELEASE_SOURCE_REVISION` references.
  const body = buildReleaseIdentity(
    {
      VERITAS_RELEASE_SOURCE_REVISION: process.env.VERITAS_RELEASE_SOURCE_REVISION,
      VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
      VERCEL_ENV: process.env.VERCEL_ENV,
    },
    isStripeLiveSalesEnabled(),
  );
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
