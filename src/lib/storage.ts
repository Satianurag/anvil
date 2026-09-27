import { createHash } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config, requireEnv } from "../config.ts";

let client: S3Client | undefined;
function s3(): S3Client {
  client ??= new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    },
  });
  return client;
}

/** Thrown when the bucket is at STORAGE_CAP_BYTES; mapped to HTTP 503 before payment. */
export class StorageFullError extends Error {}

const HEADROOM = 50_000_000;
let used: { bytes: number; at: number } | undefined;

async function usedBytes() {
  if (!used || Date.now() - used.at > 300_000) {
    let bytes = 0;
    let token: string | undefined;
    do {
      const res = await s3().send(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, ContinuationToken: token }));
      for (const o of res.Contents ?? []) bytes += o.Size ?? 0;
      token = res.NextContinuationToken;
    } while (token);
    used = { bytes, at: Date.now() };
  }
  return used;
}

/** Refuses new jobs once usage is within HEADROOM of the cap, so paid jobs don't fail mid-write. */
export async function assertCapacity() {
  const cap = config.STORAGE_CAP_BYTES;
  if (cap && (await usedBytes()).bytes > cap - HEADROOM) throw new StorageFullError("artifact storage is full");
}

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export async function putObject(key: string, body: Uint8Array | string, contentType: string) {
  const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
  const cap = config.STORAGE_CAP_BYTES;
  const usage = cap ? await usedBytes() : undefined;
  if (cap && usage && usage.bytes + size > cap) throw new StorageFullError("artifact storage is full");
  await s3().send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  if (usage) usage.bytes += size;
}

export async function getObject(key: string): Promise<Uint8Array | undefined> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return await res.Body?.transformToByteArray();
  } catch (err) {
    if (err instanceof Error && err.name === "NoSuchKey") return undefined;
    throw err;
  }
}

export function signedUrl(key: string) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), {
    expiresIn: config.ARTIFACT_URL_TTL_SECONDS,
  });
}

export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

export async function getJson<T>(key: string): Promise<T | undefined> {
  const bytes = await getObject(key);
  return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as T);
}

export const putJson = (key: string, value: unknown) =>
  putObject(key, JSON.stringify(value, null, 2), "application/json");
