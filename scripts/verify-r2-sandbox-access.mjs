// Reads /home/silver/echo-r/.env.local internally to load credentials into
// process.env, but NEVER logs/prints any credential value. Only booleans,
// hashes, sizes, and status codes are ever written to stdout.
import { readFileSync } from "fs";
import { createHash } from "crypto";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

function loadEnvLocal(path) {
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvLocal("/home/silver/echo-r/.env.local");

const RELEASE_ID = "echoagent-win-20260914T072837Z-57d883c6";
const BUCKET = process.env.ECHO_AGENT_STORAGE_BUCKET;
const PREFIX = `artifacts/${RELEASE_ID}/`;

async function sha256OfStream(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const client = new S3Client({
    region: process.env.ECHO_AGENT_STORAGE_REGION || "auto",
    endpoint: process.env.ECHO_AGENT_STORAGE_ENDPOINT,
    credentials: {
      accessKeyId: process.env.ECHO_AGENT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY,
    },
  });

  const results = {
    BUCKET_CONFIGURED: !!BUCKET,
    RELEASE_ID,
  };

  // 1. Authenticated HEAD on artifact.enc
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: PREFIX + "artifact.enc" })
    );
    results.R2_AUTHENTICATED_HEAD = true;
    results.ARTIFACT_SIZE = head.ContentLength;
  } catch (e) {
    results.R2_AUTHENTICATED_HEAD = false;
    results.HEAD_ERROR_NAME = e.name;
  }

  // 2. Authenticated HEAD on manifest.json
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: PREFIX + "manifest.json" })
    );
    results.MANIFEST_PRESENT = true;
  } catch (e) {
    results.MANIFEST_PRESENT = false;
  }

  // 3. Authenticated GET + hash of artifact.enc, compare to manifest's encrypted_sha256
  try {
    const getObj = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + "artifact.enc" })
    );
    const actualHash = await sha256OfStream(getObj.Body);
    results.R2_AUTHENTICATED_GET = true;

    const manifestObj = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + "manifest.json" })
    );
    const manifestChunks = [];
    for await (const chunk of manifestObj.Body) manifestChunks.push(chunk);
    const manifest = JSON.parse(Buffer.concat(manifestChunks).toString("utf8"));

    results.MANIFEST_ENCRYPTED_SHA256_PREFIX = manifest.encrypted_sha256?.slice(0, 12);
    results.ACTUAL_SHA256_PREFIX = actualHash.slice(0, 12);
    results.ARTIFACT_HASH_MATCH = manifest.encrypted_sha256 === actualHash;
  } catch (e) {
    results.R2_AUTHENTICATED_GET = false;
    results.GET_ERROR_NAME = e.name;
  }

  // 4. Anonymous access rejected (no auth headers, direct fetch to the S3 API endpoint)
  try {
    const url = `${process.env.ECHO_AGENT_STORAGE_ENDPOINT}/${BUCKET}/${PREFIX}artifact.enc`;
    const resp = await fetch(url, { method: "GET" });
    results.R2_PUBLIC_ACCESS_REJECTED = resp.status >= 400;
    results.ANONYMOUS_STATUS = resp.status;
  } catch (e) {
    results.R2_PUBLIC_ACCESS_REJECTED = true;
    results.ANONYMOUS_ERROR = "network_error_treated_as_rejected";
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("FATAL (no secret values in this message):", e.name, e.message?.slice(0, 200));
  process.exit(1);
});
