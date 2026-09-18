#!/usr/bin/env node
// Tests for scripts/package-echo-agent-release.mjs's two artifact
// modes (--dist, unchanged; --installer, new in this pass). Pure
// local/offline: uses a throwaway in-process KEK (never a real one)
// and never configures ECHO_AGENT_STORAGE_*, so getObjectStore()
// returns null and no real upload is attempted here -- see
// docs/release/ECHO_AGENT_INSTALLER_ARTIFACT_PROMOTION.md for the
// real upload this pass performed separately, with real sandbox
// credentials, after these tests passed.
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-release-packaging.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateDek, decryptArtifact, unwrapDek } from "../lib/artifactCrypto.ts";
import { buildDistArtifact, buildInstallerArtifact, parseArgs } from "./package-echo-agent-release.mjs";

let failures = 0;
let passes = 0;
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (condition) passes++;
  else failures++;
}

function expectThrow(name, fn) {
  try {
    fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

// Throwaway, never-real KEK, matching the existing crypto test's own
// pattern (scripts/test-echo-agent-crypto.mjs).
process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = generateDek().toString("base64");
// Never configure real storage here -- these are offline unit tests.
delete process.env.ECHO_AGENT_STORAGE_ENDPOINT;
delete process.env.ECHO_AGENT_STORAGE_BUCKET;

const workDir = mkdtempSync(path.join(tmpdir(), "echo-release-pkg-test-"));

// --- Fixtures -------------------------------------------------------

const distDir = path.join(workDir, "echo_agent_cli_v1.dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(path.join(distDir, "echo_agent_cli_v1.exe"), Buffer.from("fake nuitka exe bytes"));
writeFileSync(path.join(distDir, "readme.txt"), "fixture");

const realInstallerBytes = Buffer.concat([
  Buffer.from([0x4d, 0x5a]), // "MZ" PE/EXE magic
  Buffer.from("fake but PE-shaped installer bytes for a test fixture, deliberately not a real signed binary"),
]);
const installerPath = path.join(workDir, "ECHOAgentSetup-1.1.0.20260101T000000Z-test.exe");
writeFileSync(installerPath, realInstallerBytes);

const notExePath = path.join(workDir, "not-an-installer.zip");
writeFileSync(notExePath, Buffer.from("not an exe"));

const fakeExeWrongMagicPath = path.join(workDir, "wrong-magic.exe");
writeFileSync(fakeExeWrongMagicPath, Buffer.from("this has a .exe extension but is not PE-shaped"));

// --- --dist mode: regression, must still work unchanged --------------

{
  const result = buildDistArtifact({ releaseId: "test-dist-release", dist: [distDir] });
  check("dist mode: artifact_type is raw_dist_zip", result.artifactType === "raw_dist_zip");
  check("dist mode: content_type is application/zip", result.contentType === "application/zip");
  check("dist mode: original_filename follows ECHO-Agent-<id>.zip convention", result.originalFilename === "ECHO-Agent-test-dist-release.zip");
  check("dist mode: plaintext is non-empty", result.plaintext.length > 0);
  // ZIP local file header signature ("PK\x03\x04") -- confirms buildZip's
  // actual output shape is unchanged by this pass.
  check("dist mode: plaintext still looks like a real ZIP", result.plaintext.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
}

expectThrow("dist mode: missing directory fails closed", () => {
  buildDistArtifact({ releaseId: "x", dist: [path.join(workDir, "does_not_exist")] });
});

expectThrow("dist mode: a FILE (not a directory) passed as --dist fails closed", () => {
  buildDistArtifact({ releaseId: "x", dist: [installerPath] });
});

// --- --installer mode: the new behavior this pass adds ---------------

{
  const result = buildInstallerArtifact({ releaseId: "test-installer-release", installer: installerPath });
  check("installer mode: artifact_type is windows_installer", result.artifactType === "windows_installer");
  check("installer mode: content_type is application/octet-stream", result.contentType === "application/octet-stream");
  check("installer mode: default filename is the installer's own basename", result.originalFilename === path.basename(installerPath));
  check("installer mode: plaintext bytes are byte-for-byte identical to the source file", result.plaintext.equals(realInstallerBytes));
  check("installer mode: plaintext SHA256 matches the on-disk file's SHA256", createHash("sha256").update(result.plaintext).digest("hex") === createHash("sha256").update(readFileSync(installerPath)).digest("hex"));
}

{
  const result = buildInstallerArtifact({
    releaseId: "test-installer-release",
    installer: installerPath,
    customerFilename: "ECHOAgentSetup-1.1.0.exe",
  });
  check("installer mode: --customer-filename overrides only the manifest filename", result.originalFilename === "ECHOAgentSetup-1.1.0.exe");
  check("installer mode: --customer-filename never changes the packaged bytes", result.plaintext.equals(realInstallerBytes));
}

expectThrow("installer mode: missing file path fails closed", () => {
  buildInstallerArtifact({ releaseId: "x", installer: path.join(workDir, "does_not_exist.exe") });
});

expectThrow("installer mode: a DIRECTORY passed as --installer fails closed", () => {
  buildInstallerArtifact({ releaseId: "x", installer: distDir });
});

expectThrow("installer mode: non-.exe file extension fails closed", () => {
  buildInstallerArtifact({ releaseId: "x", installer: notExePath });
});

expectThrow("installer mode: .exe extension but wrong/missing PE magic bytes fails closed", () => {
  buildInstallerArtifact({ releaseId: "x", installer: fakeExeWrongMagicPath });
});

// --- CLI argument parsing: mutual exclusivity of --dist / --installer ---

{
  const distArgs = parseArgs(["--release-id", "r1", "--dist", "/some/dir"]);
  check("parseArgs: --dist accumulates into args.dist", distArgs.dist.length === 1 && distArgs.dist[0] === "/some/dir");
  check("parseArgs: --installer absent by default", distArgs.installer === undefined);

  const installerArgs = parseArgs(["--release-id", "r2", "--installer", "/some/file.exe", "--customer-filename", "X.exe"]);
  check("parseArgs: --installer captured", installerArgs.installer === "/some/file.exe");
  check("parseArgs: --customer-filename captured", installerArgs.customerFilename === "X.exe");
  check("parseArgs: --dist stays empty when only --installer is given", installerArgs.dist.length === 0);
}

// --- End-to-end: encrypt the installer artifact exactly as main() would,
// then decrypt it back and prove the round trip is lossless -- this is
// the strongest proof that "installer bytes remain unchanged" holds
// through the full encrypt path, not just at the builder-function level.

{
  const { encryptArtifact, wrapDek, getArtifactKek } = await import("../lib/artifactCrypto.ts");
  const built = buildInstallerArtifact({ releaseId: "roundtrip-release", installer: installerPath, customerFilename: "ECHOAgentSetup-1.1.0.exe" });
  const kek = getArtifactKek();
  const { ciphertext, iv, authTag, dek } = encryptArtifact(built.plaintext);
  const wrapped = wrapDek(dek, kek);
  const unwrappedDek = unwrapDek(
    { wrappedDek: wrapped.wrappedDek, wrappedDekIv: wrapped.wrappedDekIv, wrappedDekAuthTag: wrapped.wrappedDekAuthTag },
    kek,
  );
  const decrypted = decryptArtifact(ciphertext, unwrappedDek, iv, authTag);
  check("installer round-trip: decrypt(encrypt(installer bytes)) is byte-for-byte identical to the original file", decrypted.equals(realInstallerBytes));
}

rmSync(workDir, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures > 0 ? 1 : 0);
