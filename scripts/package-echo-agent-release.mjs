#!/usr/bin/env node
// Packages the built ECHO Agent Nuitka release into a single ZIP,
// AES-256-GCM-encrypts it under a fresh DEK wrapped by
// ECHO_AGENT_ARTIFACT_KEK_B64, and uploads the encrypted object +
// manifest to private storage (if ECHO_AGENT_STORAGE_* is
// configured). See ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md.
//
// This is an OPERATOR tool, run manually after a real Nuitka build
// (docs/PROPRIETARY_RELEASE_BUILD.md in the ECHODiscord版 repo) -- it
// never runs as part of `npm run build` or any request path.
//
// Usage:
//   node --experimental-strip-types scripts/package-echo-agent-release.mjs \
//     --release-id <id> \
//     --dist <path-to-echo_agent_cli_v1.dist> \
//     --dist <path-to-echo_agent_computer_use_service_v1.dist> \
//     [--out <local-output-dir>]   (default: ./release-output/<release-id>)
//
// If ECHO_AGENT_STORAGE_* is not configured, the encrypted artifact
// and manifest are still produced and written locally -- upload is
// reported as SKIPPED, not silently faked as done.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { listFilesForZip, buildZip } from "./lib/zip.mjs";
import { encryptArtifact, wrapDek, getArtifactKek } from "../lib/artifactCrypto.ts";
import { getObjectStore } from "../lib/storage.ts";
import { releaseArtifactKey, releaseManifestKey } from "../lib/release.ts";

function parseArgs(argv) {
  const args = { dist: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--release-id") args.releaseId = argv[++i];
    else if (a === "--dist") args.dist.push(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.releaseId || args.dist.length === 0) {
    console.error("Usage: package-echo-agent-release.mjs --release-id <id> --dist <path> [--dist <path> ...] [--out <dir>]");
    process.exit(1);
  }
  for (const d of args.dist) {
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      console.error(`--dist path does not exist or is not a directory: ${d}`);
      process.exit(1);
    }
  }

  const kek = getArtifactKek();
  if (!kek) {
    console.error("ECHO_AGENT_ARTIFACT_KEK_B64 is not set (or not a valid 32-byte base64 value) -- cannot encrypt without a KEK. Refusing to produce a plaintext-only 'release'.");
    process.exit(1);
  }

  console.log(`Packaging release ${args.releaseId} from ${args.dist.length} dist director${args.dist.length === 1 ? "y" : "ies"}...`);

  const entries = [];
  for (const distDir of args.dist) {
    const baseName = path.basename(distDir);
    entries.push(...listFilesForZip(distDir, baseName));
  }
  console.log(`Collected ${entries.length} files.`);

  const zipBuffer = buildZip(entries);
  const originalFilename = `ECHO-Agent-${args.releaseId}.zip`;
  console.log(`Built ${originalFilename}: ${zipBuffer.length} bytes.`);

  const artifactSha256 = createHash("sha256").update(zipBuffer).digest("hex");

  const { ciphertext, iv, authTag, dek } = encryptArtifact(zipBuffer);
  const encryptedSha256 = createHash("sha256").update(ciphertext).digest("hex");
  const wrapped = wrapDek(dek, kek);

  const manifest = {
    schema: "veritasforge.echo-agent.release-manifest.v1",
    release_id: args.releaseId,
    artifact_sha256: artifactSha256,
    encrypted_sha256: encryptedSha256,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
    wrapped_dek: wrapped.wrappedDek.toString("base64"),
    wrapped_dek_iv: wrapped.wrappedDekIv.toString("base64"),
    wrapped_dek_auth_tag: wrapped.wrappedDekAuthTag.toString("base64"),
    original_filename: originalFilename,
    content_type: "application/zip",
    byte_size: zipBuffer.length,
    created_at: new Date().toISOString(),
  };

  const outDir = args.out || path.join(process.cwd(), "release-output", args.releaseId);
  mkdirSync(outDir, { recursive: true });
  const encryptedPath = path.join(outDir, "artifact.enc");
  const manifestPath = path.join(outDir, "manifest.json");
  writeFileSync(encryptedPath, ciphertext);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Wrote encrypted artifact + manifest locally to ${outDir}`);

  const store = getObjectStore();
  let uploadStatus = "SKIPPED (ECHO_AGENT_STORAGE_* not configured)";
  if (store) {
    await store.putObject(releaseArtifactKey(args.releaseId), ciphertext, "application/octet-stream");
    await store.putObject(releaseManifestKey(args.releaseId), Buffer.from(JSON.stringify(manifest)), "application/json");
    uploadStatus = "UPLOADED";
  }

  console.log("\n=== Release packaging summary ===");
  console.log(`ARTIFACT_RELEASE_ID=${args.releaseId}`);
  console.log(`PLAINTEXT_SHA256=${artifactSha256}`);
  console.log(`ENCRYPTED_SHA256=${encryptedSha256}`);
  console.log(`PLAINTEXT_BYTE_SIZE=${zipBuffer.length}`);
  console.log(`ENCRYPTED_BYTE_SIZE=${ciphertext.length}`);
  console.log(`STORAGE_UPLOAD=${uploadStatus}`);
  console.log(`LOCAL_OUTPUT_DIR=${outDir}`);
  console.log(`\nSet ECHO_AGENT_ARTIFACT_RELEASE_ID=${args.releaseId} in the website's environment once the upload above is confirmed.`);
  // The AWS SDK S3 client can leave a keep-alive HTTP socket open,
  // which would otherwise leave this process hanging instead of
  // exiting naturally after a successful run.
  process.exit(0);
}

main().catch((error) => {
  console.error("Packaging failed:", error);
  process.exit(1);
});
