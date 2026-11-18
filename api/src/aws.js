// Real AWS implementations of the `db` and `storage` interfaces used by app.js.
// Credentials come from the EC2 instance role via IMDSv2; nothing is stored on disk.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function createDb({ region, tableName }) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const pk = (sub) => `USER#${sub}`;

  return {
    async getJob(sub, jobId) {
      const { Item } = await doc.send(new GetCommand({
        TableName: tableName, Key: { PK: pk(sub), SK: `JOB#${jobId}` },
      }));
      return Item;
    },

    async putJob(sub, job) {
      await doc.send(new PutCommand({
        TableName: tableName,
        Item: { PK: pk(sub), SK: `JOB#${job.jobId}`, ...job },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
    },

    async listJobs(sub) {
      const { Items = [] } = await doc.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :job)",
        ExpressionAttributeValues: { ":pk": pk(sub), ":job": "JOB#" },
        Limit: 50,
      }));
      // TTL deletion can lag; hide anything already past expiry.
      const nowSec = Math.floor(Date.now() / 1000);
      return Items.filter((j) => !j.expiresAt || j.expiresAt > nowSec);
    },

    async deleteJob(sub, jobId) {
      await doc.send(new DeleteCommand({
        TableName: tableName, Key: { PK: pk(sub), SK: `JOB#${jobId}` },
      }));
    },

    // Atomic counter: increments only while under the limit. Returns uploads
    // left today, or -1 if the limit is already reached.
    async consumeQuota(sub, date, limit) {
      const day = date.toISOString().slice(0, 10);
      try {
        const { Attributes } = await doc.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: pk(sub), SK: `QUOTA#${day}` },
          UpdateExpression: "ADD uploads :one SET expiresAt = if_not_exists(expiresAt, :exp)",
          ConditionExpression: "attribute_not_exists(uploads) OR uploads < :limit",
          ExpressionAttributeValues: {
            ":one": 1,
            ":limit": limit,
            ":exp": Math.floor(date.getTime() / 1000) + 2 * 24 * 60 * 60,
          },
          ReturnValues: "UPDATED_NEW",
        }));
        return limit - Attributes.uploads;
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") return -1;
        throw err;
      }
    },
  };
}

export function createStorage({ region, bucket }) {
  const s3 = new S3Client({ region });
  return {
    // Presigned POST (not PUT) so S3 itself enforces size and content type.
    async presignUpload({ key, contentType, minBytes, maxBytes, expiresIn }) {
      const { url, fields } = await createPresignedPost(s3, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ["content-length-range", minBytes, maxBytes],
          ["eq", "$Content-Type", contentType],
        ],
        Fields: { "Content-Type": contentType },
        Expires: expiresIn,
      });
      return { url, fields };
    },
    presignView({ key, expiresIn }) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    },
    async deleteObject({ key }) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
