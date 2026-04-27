import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { media, jobs } from "../db/schema.js";
import { eq, ne, desc, and } from "drizzle-orm";
import { thumbnailQueue, videoQueue } from "../services/queue.js";

interface DebugJobsQuery {
  status?: "pending" | "active" | "completed" | "failed";
  type?: "thumbnail" | "video";
}

interface DebugMediaPendingQuery {
  type?: "image" | "video";
}

export async function debugRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: DebugJobsQuery }>("/debug/jobs", async (request, reply) => {
    const { status, type } = request.query;

    let query = db.select().from(jobs).$dynamic();

    if (status) {
      query = query.where(eq(jobs.status, status));
    }
    if (type) {
      query = query.where(eq(jobs.type, type));
    }

    const rows = await query.orderBy(desc(jobs.createdAt)).limit(100);

    const result = await Promise.all(
      rows.map(async (job) => {
        const [mediaRow] = await db
          .select({
            id: media.id,
            fileName: media.fileName,
            type: media.type,
            status: media.status,
            originalPath: media.originalPath,
            thumbnailPath: media.thumbnailPath,
            animatedThumbnailPath: media.animatedThumbnailPath,
            previewPath: media.previewPath,
          })
          .from(media)
          .where(eq(media.id, job.mediaId))
          .limit(1);

        return {
          job: {
            id: job.id,
            mediaId: job.mediaId,
            type: job.type,
            status: job.status,
            attempts: job.attempts,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
          },
          media: mediaRow ?? null,
        };
      })
    );

    return reply.send({ data: result });
  });

  app.get<{ Querystring: DebugMediaPendingQuery }>("/debug/media/pending", async (request, reply) => {
    const { type } = request.query;

    const conditions = [ne(media.status, "ready")];
    if (type) {
      conditions.push(eq(media.type, type));
    }

    const rows = await db
      .select({
        id: media.id,
        fileName: media.fileName,
        type: media.type,
        mimeType: media.mimeType,
        fileSize: media.fileSize,
        status: media.status,
        originalPath: media.originalPath,
        thumbnailPath: media.thumbnailPath,
        animatedThumbnailPath: media.animatedThumbnailPath,
        previewPath: media.previewPath,
        createdAt: media.createdAt,
      })
      .from(media)
      .where(and(...conditions))
      .orderBy(desc(media.createdAt));

    return reply.send({ data: rows });
  });

  app.get("/debug/queues", async (request, reply) => {
    const [thumbCounts, videoCounts] = await Promise.all([
      thumbnailQueue.getJobCounts(),
      videoQueue.getJobCounts(),
    ]);

    return reply.send({
      data: {
        thumbnail: {
          waiting: thumbCounts.waiting,
          active: thumbCounts.active,
          completed: thumbCounts.completed,
          failed: thumbCounts.failed,
          delayed: thumbCounts.delayed,
        },
        video: {
          waiting: videoCounts.waiting,
          active: videoCounts.active,
          completed: videoCounts.completed,
          failed: videoCounts.failed,
          delayed: videoCounts.delayed,
        },
      },
    });
  });
}
