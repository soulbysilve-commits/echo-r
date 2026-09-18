#!/usr/bin/env node
// Packages a built ECHO Agent release artifact, AES-256-GCM-encrypts
// it under a fresh DEK wrapped by ECHO_AGENT_ARTIFACT_KEK_B64, and
// uploads the encrypted object + manifest to private storage (if
// ECHO_AGENT_STORAGE_* is configured). See
// ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md.
//
// This is an OPERATOR tool, run manually after a real build
// (docs/PROPRIETARY_RELEASE_BUILD.md in the ECHODiscord版 repo) -- it
// never runs as part of `npm run build` or any request path.
//
// Two mutually exclusive artifact modes -- exactly one is required:
//
//   1. --dist mode (raw internal/build artifact, unchanged): zips one
//      or more Nuitka standalone dist directories together.
//        --dist <path-to-echo_agent_cli_v1.dist> \
//        --dist <path-to-echo_agent_computer_use_service_v1.dist>
//
//   2. --installer mode (the customer-distributed Windows GUI
//      installer): packages ONE existing .exe file's EXACT bytes --
//      never rebuilt, never modified, never re-zipped. Hashing and
//      encryption run directly over the file's own bytes.
//        --installer <path-to-ECHOAgentSetup-....exe> \
//        [--customer-filename <name.exe>]   (default: the installer's
//         own basename -- use this to present a stable customer-facing
//         name without touching the underlying validated bytes, e.g.
//         to avoid exposing an internal "-nextqa" build tag)
//
// Common options:
//   --release-id <id>
//   [--out <local-output-dir>]   (default: ./release-output/<release-id>)
//
// If ECHO_AGENT_STORAGE_* is not configured, the encrypted artifact
// and manifest are still produced and written locally -- upload is
// reported as SKIPPED, not silently faked as done.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { listFilesForZip, buildZip } from "./lib/zip.mjs";
import { encryptArtifact, wrapDek, getArtifactKek } from "../lib/artifactCrypto.ts";
import { getObjectStore } from "../lib/storage.ts";
import { releaseArtifactKey, releaseManifestKey } from "../lib/release.ts";

export function parseArgs(argv) {
  const args = { dist: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--release-id") args.releaseId = argv[++i];
    else if (a === "--dist") args.dist.push(argv[++i]);
    else if (a === "--installer") args.installer = argv[++i];
    else if (a === "--customer-filename") args.customerFilename = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

/** Builds the plaintext artifact bytes + manifest fields for --dist
 * mode -- byte-for-byte the existing, unmodified behavior. */
export function buildDistArtifact(args) {
  for (const d of args.dist) {
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      throw new Error(`--dist path does not exist or is not a directory: ${d}`);
    }
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
  return {
    plaintext: zipBuffer,
    artifactType: "raw_dist_zip",
    originalFilename,
    contentType: "application/zip",
  };
}

/** Builds the plaintext artifact bytes + manifest fields for
 * --installer mode. Reads the EXACT existing file bytes -- no
 * rebuild, no modification, no re-encoding. The only thing that can
 * differ from the on-disk file is the customer-facing filename
 * (Content-Disposition only; never the bytes hashed/encrypted
 * below), via --customer-filename. */
export function buildInstallerArtifact(args) {
  if (!existsSync(args.installer) || !statSync(args.installer).isFile()) {
    throw new Error(`--installer path does not exist or is not a file: ${args.installer}`);
  }
  if (!args.installer.toLowerCase().endsWith(".exe")) {
    throw new Error(`--installer path must be a .exe file (fail closed -- refusing to guess artifact type for: ${args.installer})`);
  }
  console.log(`Packaging release ${args.releaseId} from installer ${args.installer}...`);
  const exeBuffer = readFileSync(args.installer);
  // Fail closed on a file that doesn't even look like a PE/EXE ("MZ"
  // magic bytes) -- catches an obviously wrong/corrupt --installer
  // path before it ever gets encrypted and uploaded as if valid.
  if (exeBuffer.length < 2 || exeBuffer[0] !== 0x4d || exeBuffer[1] !== 0x5a) {
    throw new Error(`--installer file does not start with the PE/EXE "MZ" signature -- refusing to package: ${args.installer}`);
  }
  const originalFilename = args.customerFilename || path.basename(args.installer);
  console.log(`Using installer bytes as-is: ${exeBuffer.length} bytes. Customer-facing filename: ${originalFilename}`);
  return {
    plaintext: exeBuffer,
    artifactType: "windows_installer",
    originalFilename,
    contentType: "application/octet-stream",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hasDist = args.dist.length > 0;
  const hasInstaller = typeof args.installer === "string" && args.installer.length > 0;
  if (!args.releaseId || (!hasDist && !hasInstaller) || (hasDist && hasInstaller)) {
    console.error(
      "Usage: package-echo-agent-release.mjs --release-id <id> " +
      "(--dist <path> [--dist <path> ...] | --installer <path.exe> [--customer-filename <name.exe>]) " +
      "[--out <dir>]\n" +
      "Exactly one of --dist / --installer is required, never both."
    );
    process.exit(1);
  }

  const kek = getArtifactKek();
  if (!kek) {
    console.error("ECHO_AGENT_ARTIFACT_KEK_B64 is not set (or not a valid 32-byte base64 value) -- cannot encrypt without a KEK. Refusing to produce a plaintext-only 'release'.");
    process.exit(1);
  }

  const { plaintext, artifactType, originalFilename, contentType } = hasInstaller
    ? buildInstallerArtifact(args)
    : buildDistArtifact(args);

  const artifactSha256 = createHash("sha256").update(plaintext).digest("hex");

  const { ciphertext, iv, authTag, dek } = encryptArtifact(plaintext);
  const encryptedSha256 = createHash("sha256").update(ciphertext).digest("hex");
  const wrapped = wrapDek(dek, kek);

  const manifest = {
    schema: "veritasforge.echo-agent.release-manifest.v1",
    release_id: args.releaseId,
    // Additive field (absent on every manifest written before this
    // change) -- callers that don't know about it can keep ignoring
    // it exactly as before; nothing existing reads or requires it.
    // "raw_dist_zip" is the pre-existing (and still default) shape;
    // "windows_installer" is new.
    artifact_type: artifactType,
    artifact_sha256: artifactSha256,
    encrypted_sha256: encryptedSha256,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
    wrapped_dek: wrapped.wrappedDek.toString("base64"),
    wrapped_dek_iv: wrapped.wrappedDekIv.toString("base64"),
    wrapped_dek_auth_tag: wrapped.wrappedDekAuthTag.toString("base64"),
    original_filename: originalFilename,
    content_type: contentType,
    byte_size: plaintext.length,
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
  console.log(`ARTIFACT_TYPE=${artifactType}`);
  console.log(`ORIGINAL_FILENAME=${originalFilename}`);
  console.log(`PLAINTEXT_SHA256=${artifactSha256}`);
  console.log(`ENCRYPTED_SHA256=${encryptedSha256}`);
  console.log(`PLAINTEXT_BYTE_SIZE=${plaintext.length}`);
  console.log(`ENCRYPTED_BYTE_SIZE=${ciphertext.length}`);
  console.log(`STORAGE_UPLOAD=${uploadStatus}`);
  console.log(`LOCAL_OUTPUT_DIR=${outDir}`);
  console.log(`\nSet ECHO_AGENT_ARTIFACT_RELEASE_ID=${args.releaseId} in the website's environment once the upload above is confirmed.`);
  // The AWS SDK S3 client can leave a keep-alive HTTP socket open,
  // which would otherwise leave this process hanging instead of
  // exiting naturally after a successful run.
  process.exit(0);
}

// Guarded so importing this module's exported functions (e.g. from
// scripts/test-echo-agent-release-packaging.mjs) never triggers a
// full CLI run as a side effect -- only running this file directly
// does.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Packaging failed:", error);
    process.exit(1);
  });
}
