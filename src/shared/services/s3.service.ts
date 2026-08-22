import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const endpoint =
  process.env.S3_ENDPOINT ||
  process.env.AWS_ENDPOINT_URL ||
  process.env.LOCALSTACK_URL;
const s3Client = new S3Client({
  endpoint: endpoint || undefined,
  forcePathStyle: !!endpoint,
  region: process.env.AWS_REGION || "ap-southeast-1",
  credentials: endpoint
    ? { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" }
    : undefined,
});
const BUCKET_NAME = process.env.AWS_S3_BUCKET || "helpme-avatars-local";

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

export async function getPresignedDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
