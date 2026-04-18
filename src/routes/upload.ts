import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { media } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { enqueueThumbnailJob } from "../services/queue.js";
import { originalPath, thumbnailPath, mediaShardPath } from "../services/storage.js";
import * as fs from "fs/promises";
import * as path from "path";

const hardcodedUserId = "00000000-0000-0000-0000-000000000000";

const tracer = trace.getTracer("glimps-api");
const meter = metrics.getMeter("glimps-api");

const uploadTotal = meter.createCounter("media.upload.total", {
  description: "Total number of media uploads",
});

const uploadDuration = meter.createHistogram("media.upload.duration", {
  description: "Time taken to process an upload",
  unit: "ms",
});

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function generateFileName(originalName: string): string {
  const ext = path.extname(originalName);
  const stem = path.basename(originalName, ext);
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${stem}-${timestamp}-${random}${ext}`;
}

export async function uploadRoute(app: FastifyInstance): Promise<void> {
  app.post("/api/media/upload", async (request, reply) => {
    const span = tracer.startSpan("media.upload");
    const startTime = Date.now();

    span.setAttributes({ "upload.user_id": hardcodedUserId });

    let fileName: string | undefined;
    let mimeType: string | undefined;
    let buffer: Buffer | undefined;

    try {
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === "file") {
          const chunks: Uint8Array[] = [];
          const stream = part.file;
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          buffer = Buffer.concat(chunks);
          fileName = part.filename;
          mimeType = part.mimetype;
        }
      }
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "parse failed" });
      span.end();
      uploadDuration.record(Date.now() - startTime, { status: "error" });
      request.log.error({ err }, "upload parse failed");
      return reply.status(400).send({ error: "upload parse failed" });
    }

    if (!buffer || !fileName || !mimeType) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "missing file" });
      span.end();
      uploadDuration.record(Date.now() - startTime, { status: "error" });
      return reply.status(400).send({ error: "missing file" });
    }

    const fileSize = buffer.length;
    const isVideo = mimeType.startsWith("video/");
    const mediaType = isVideo ? "video" : "image";

    span.setAttributes({
      "media.type": mediaType,
      "media.file_name": fileName,
      "media.file_size": fileSize,
    });

    let storedPath: string;
    let thumbPath: string;

    try {
      const storedFileName = generateFileName(fileName);
      storedPath = originalPath(hardcodedUserId, storedFileName);
      thumbPath = thumbnailPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".jpg"));

      await ensureDir(path.dirname(storedPath));
      await fs.writeFile(storedPath, buffer);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "file write failed" });
      span.end();
      uploadDuration.record(Date.now() - startTime, { status: "error" });
      request.log.error({ err, fileName }, "file write failed");
      return reply.status(500).send({ error: "file write failed" });
    }

    let mediaRecord: typeof media.$inferSelect;

    try {
      [mediaRecord] = await db
        .insert(media)
        .values({
          userId: hardcodedUserId,
          originalPath: storedPath,
          thumbnailPath: null,
          status: "pending",
          type: mediaType,
          fileName,
          mimeType,
          fileSize,
          shardPath: mediaShardPath(hardcodedUserId),
          metadata: {},
        })
        .returning();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "database insert failed" });
      span.end();
      uploadDuration.record(Date.now() - startTime, { status: "error" });
      request.log.error({ err }, "database insert failed");
      try {
        await fs.unlink(storedPath);
      } catch {
        // ignore cleanup failure
      }
      return reply.status(500).send({ error: "database insert failed" });
    }

    span.setAttributes({ "media.id": mediaRecord.id });
    request.log.info({ mediaId: mediaRecord.id, type: mediaType, fileName }, "media uploaded");
    uploadTotal.add(1, { type: mediaType, status: "success" });

    if (!isVideo) {
      const jobSpan = tracer.startSpan("media.job.enqueue");
      jobSpan.setAttributes({ "media.id": mediaRecord.id, "job.type": "thumbnail" });

      try {
        const jobId = await enqueueThumbnailJob(mediaRecord.id, storedPath, thumbPath);
        jobSpan.setStatus({ code: SpanStatusCode.OK });
        jobSpan.end();
        request.log.info({ mediaId: mediaRecord.id, jobId }, "thumbnail job enqueued");
      } catch (err) {
        jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: "job enqueue failed" });
        jobSpan.end();
        uploadDuration.record(Date.now() - startTime, { status: "error" });
        uploadTotal.add(1, { type: mediaType, status: "error" });
        request.log.error({ err, mediaId: mediaRecord.id }, "job enqueue failed");
        await db.update(media).set({ status: "failed" }).where(eq(media.id, mediaRecord.id));
        return reply.status(500).send({ error: "job enqueue failed" });
      }
    } else {
      await db.update(media).set({ status: "pending_video" }).where(eq(media.id, mediaRecord.id));
      request.log.info({ mediaId: mediaRecord.id }, "video pending transcoding");
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    uploadDuration.record(Date.now() - startTime, { status: "success" });

    return reply.status(201).send({ id: mediaRecord.id, status: mediaRecord.status });
  });
}