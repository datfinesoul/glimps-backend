import { Queue } from "bullmq";
import { env } from "../env.js";
import { db } from "../db/index.js";
import { jobs } from "../db/schema.js";

export const thumbnailQueueName = "thumbnail";

export function createThumbnailQueue(): Queue {
  return new Queue(thumbnailQueueName, {
    connection: { url: env.REDIS_URL },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
}

export async function enqueueThumbnailJob(
  mediaId: string,
  originalPath: string,
  thumbnailPath: string,
): Promise<string> {
  const queue = createThumbnailQueue();

  const [job] = await db
    .insert(jobs)
    .values({
      mediaId,
      type: "thumbnail",
      status: "pending",
    })
    .returning();

  await queue.add(
    "generate",
    {
      jobId: job.id,
      mediaId,
      originalPath,
      thumbnailPath,
    },
    { jobId: job.id },
  );

  return job.id;
}