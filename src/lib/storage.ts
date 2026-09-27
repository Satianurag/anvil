import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export async function putObject(key: string, body: Uint8Array | string, contentType: string) {
  await s3().send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
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
