import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Inlines the release source revision into the bundle at BUILD time so
  // app/api/release-identity can report which revision this deployment
  // was built from. veritas-release-orchestrator passes it as
  // `vercel deploy --build-env VERITAS_RELEASE_SOURCE_REVISION=<sha>`;
  // anything else (a hand-made deploy, `next dev`) leaves it empty and
  // the endpoint reports null. Not a secret -- a public git SHA.
  env: {
    VERITAS_RELEASE_SOURCE_REVISION: process.env.VERITAS_RELEASE_SOURCE_REVISION ?? "",
  },
};

export default nextConfig;
