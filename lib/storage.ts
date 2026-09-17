import { GetObjectCommand, HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "stream";

/**
 * Private, S3-compatible object storage for ECHO Agent fulfillment
 * data: the encrypted release artifact, its manifest, and small
 * entitlement/subscription/event/download-claim JSON records (see
 * lib/entitlement.ts). Works against AWS S3, Cloudflare R2, or any
 * other S3-compatible provider via ECHO_AGENT_STORAGE_ENDPOINT.
 *
 * Nothing in this module ever produces or accepts a public URL --
 * every read/write goes through the authenticated S3 API client, and
 * callers (route handlers) are the only thing that ever streams bytes
 * to a browser, only after their own authorization checks pass. See
 * ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md for the full delivery model.
 */

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Reads ECHO_AGENT_STORAGE_* from the environment. Returns null (not
 * throw) if any required variable is missing, so callers can fail
 * closed with a clear "storage not configured" response. Never logs
 * the secret access key. */
export function getStorageConfig(): StorageConfig | null {
  const endpoint = process.env.ECHO_AGENT_STORAGE_ENDPOINT?.trim();
  const region = process.env.ECHO_AGENT_STORAGE_REGION?.trim();
  const bucket = process.env.ECHO_AGENT_STORAGE_BUCKET?.trim();
  const accessKeyId = process.env.ECHO_AGENT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  const forcePathStyle = process.env.ECHO_AGENT_STORAGE_FORCE_PATH_STYLE === "true";
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle };
}

let cachedClient: S3Client | null = null;
let cachedClientEndpoint: string | null = null;

function getClient(config: StorageConfig): S3Client {
  if (cachedClient && cachedClientEndpoint === config.endpoint) return cachedClient;
  cachedClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  cachedClientEndpoint = config.endpoint;
  return cachedClient;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface ObjectStore {
  /** Fetches an object's full body as a Buffer. Throws if missing. */
  getObjectBuffer(key: string): Promise<Buffer>;
  /** Fetches an object's body as a readable stream, for large-object
   * streaming decrypt paths. Throws if missing. */
  getObjectStream(key: string): Promise<Readable>;
  /** Unconditional overwrite-or-create. Used for the encrypted
   * artifact/manifest (operator-controlled packaging step, not a
   * concurrency-sensitive path). */
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Conditional create-if-absent (S3/R2 `If-None-Match: *`). Returns
   * true if this call created the object, false if it already
   * existed (someone else won the race / this is a replay). This is
   * the primitive that makes webhook idempotency and one-time
   * download-token consumption atomic -- never implement "get, check,
   * then put" as a substitute, that has a race window. */
  putObjectIfAbsent(key: string, body: Buffer, contentType?: string): Promise<{ created: boolean }>;
  headObject(key: string): Promise<{ exists: boolean }>;
}

class S3ObjectStore implements ObjectStore {
  private client: S3Client;
  private bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return streamToBuffer(res.Body as Readable);
  }

  async getObjectStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async putObjectIfAbsent(key: string, body: Buffer, contentType?: string): Promise<{ created: boolean }> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: "*",
        }),
      );
      return { created: true };
    } catch (err) {
      // S3/R2 do not model "IfNoneMatch precondition failed" as a
      // typed SDK exception -- it comes back as a generic error with
      // HTTP 412. Checking the status code is the correct,
      // provider-portable way to detect it (also covers
      // "PreconditionFailed" surfacing under different error `name`
      // values across S3-compatible providers).
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 412 || name === "PreconditionFailed") return { created: false };
      // Some S3-compatible providers reject the IfNoneMatch precondition
      // outright (unsupported) rather than evaluating it -- treat that
      // as a hard configuration/compatibility failure rather than
      // silently downgrading to a non-atomic write, so callers (and
      // STRICT_ONE_TIME_DOWNLOAD reporting) never lie about atomicity.
      throw err;
    }
  }

  async headObject(key: string): Promise<{ exists: boolean }> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { exists: true };
    } catch (err) {
      if (err instanceof NotFound) return { exists: false };
      throw err;
    }
  }
}

/** Returns a configured ObjectStore, or null if ECHO_AGENT_STORAGE_*
 * is not fully configured -- callers must fail closed on null rather
 * than falling back to any other storage. */
export function getObjectStore(): ObjectStore | null {
  const config = getStorageConfig();
  if (!config) return null;
  const client = getClient(config);
  return new S3ObjectStore(client, config.bucket);
}
