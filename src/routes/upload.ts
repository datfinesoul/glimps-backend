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

    try {
      const parts = request.parts();
      const results: Array<{ id: string; status: string }> = [];
      const errors: Array<{ fileName: string; error: string }> = [];

      for await (const part of parts) {
        if (part.type !== "file") continue;

        const chunks: Uint8Array[] = [];
        const stream = part.file;
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const fileName = part.filename;
        const mimeType = part.mimetype;

        if (!buffer || !fileName || !mimeType) {
          errors.push({ fileName: fileName || "unknown", error: "missing file data" });
          continue;
        }

        const fileSize = buffer.length;
        const isVideo = mimeType.startsWith("video/");
        const mediaType = isVideo ? "video" : "image";

        const fileSpan = tracer.startSpan("media.upload.file");
        fileSpan.setAttributes({
          "media.type": mediaType,
          "media.file_name": fileName,
          "media.file_size": fileSize,
        });

        let storedPath: string;
        let thumbPath: string;

        try {
          const storedFileName = generateFileName(fileName);
          storedPath = originalPath(hardcodedUserId, storedFileName);
          thumbPath = thumbnailPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".webp"));

          await ensureDir(path.dirname(storedPath));
          await fs.writeFile(storedPath, buffer);
        } catch (err) {
          fileSpan.setStatus({ code: SpanStatusCode.ERROR, message: "file write failed" });
          fileSpan.end();
          uploadDuration.record(Date.now() - startTime, { status: "error" });
          request.log.error({ err, fileName }, "file write failed");
          errors.push({ fileName, error: "file write failed" });
          continue;
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
          fileSpan.setStatus({ code: SpanStatusCode.ERROR, message: "database insert failed" });
          fileSpan.end();
          request.log.error({ err }, "database insert failed");
          try {
            await fs.unlink(storedPath);
          } catch {
            // ignore cleanup failure
          }
          errors.push({ fileName, error: "database insert failed" });
          continue;
        }

        fileSpan.setAttributes({ "media.id": mediaRecord.id });
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
            uploadTotal.add(1, { type: mediaType, status: "error" });
            request.log.error({ err, mediaId: mediaRecord.id }, "job enqueue failed");
            await db.update(media).set({ status: "failed" }).where(eq(media.id, mediaRecord.id));
            errors.push({ fileName, error: "job enqueue failed" });
            continue;
          }
        } else {
          await db.update(media).set({ status: "pending_video" }).where(eq(media.id, mediaRecord.id));
          request.log.info({ mediaId: mediaRecord.id }, "video pending transcoding");
        }

        fileSpan.setStatus({ code: SpanStatusCode.OK });
        fileSpan.end();
        results.push({ id: mediaRecord.id, status: mediaRecord.status });
      }

      if (results.length === 0 && errors.length > 0) {
        return reply.status(400).send({ error: "all uploads failed", details: errors });
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      uploadDuration.record(Date.now() - startTime, { status: "success" });

      return reply.status(201).send({
        results,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "parse failed" });
      span.end();
      uploadDuration.record(Date.now() - startTime, { status: "error" });
      request.log.error({ err }, "upload parse failed");
      return reply.status(400).send({ error: "upload parse failed" });
    }
  });
}
