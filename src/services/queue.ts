import { Queue } from "bullmq";
import { env } from "../env.js";
import { db } from "../db/index.js";
import { jobs } from "../db/schema.js";

export const thumbnailQueueName = "thumbnail";
export const videoQueueName = "video";

const queueConnection = { url: env.REDIS_URL };

export const thumbnailQueue = new Queue<{
  jobId: string;
  mediaId: string;
  originalPath: string;
  thumbnailPath: string;
}>(thumbnailQueueName, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const videoQueue = new Queue<{
  jobId: string;
  mediaId: string;
  originalPath: string;
  thumbnailPath: string;
  animatedThumbnailPath: string;
  previewPath: string;
  gpuEnabled: boolean;
}>(videoQueueName, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export function createThumbnailQueue(): Queue {
  return thumbnailQueue;
}

export function createVideoQueue(): Queue {
  return videoQueue;
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

export interface VideoJobData {
  jobId: string;
  mediaId: string;
  originalPath: string;
  thumbnailPath: string;
  animatedThumbnailPath: string;
  previewPath: string;
  gpuEnabled: boolean;
}

export async function enqueueVideoJob(data: VideoJobData): Promise<string> {
  const queue = createVideoQueue();

  const [job] = await db
    .insert(jobs)
    .values({
      mediaId: data.mediaId,
      type: "video",
      status: "pending",
    })
    .returning();

  await queue.add(
    "process",
    { ...data, jobId: job.id },
    { jobId: job.id },
  );

  return job.id;
}