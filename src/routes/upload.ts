import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { media } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { enqueueThumbnailJob, enqueueVideoJob } from "../services/queue.js";
import { originalPath, thumbnailPath, mediaShardPath, animatedThumbnailPath, previewPath } from "../services/storage.js";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  codec: string;
}

async function extractVideoMetadata(filePath: string): Promise<VideoMetadata> {
  const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
  const { stdout } = await execAsync(cmd);
  const data = JSON.parse(stdout);

  const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const format = data.format;

  return {
    duration: Math.round(parseFloat(format?.duration ?? "0")),
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    codec: videoStream?.codec_name ?? "unknown",
  };
}

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
    const uploadOffset = request.headers["upload-offset"];
    const uploadLength = request.headers["upload-length"];
    const uploadComplete = request.headers["upload-complete"];

    if (uploadOffset !== undefined || uploadLength !== undefined) {
      const offset = uploadOffset ? parseInt(String(uploadOffset), 10) : 0;
      const length = uploadLength ? parseInt(String(uploadLength), 10) : 0;

      if (uploadComplete === "true") {
        const { fileName, mimeType } = request.body as { fileName?: string; mimeType?: string };
        if (!fileName || !mimeType) {
          return reply.status(400).send({ error: "missing file metadata" });
        }

        const storedFileName = generateFileName(fileName);
        const storedPath = originalPath(hardcodedUserId, storedFileName);

        try {
          const stat = await fs.stat(storedPath);
          if (stat.size !== length) {
            return reply.status(409).send({ error: "upload length mismatch" });
          }

          const isVideo = mimeType.startsWith("video/");
          const mediaType = isVideo ? "video" : "image";
          const thumbPath = thumbnailPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".webp"));
          const animPath = animatedThumbnailPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".webm"));
          const prevPath = previewPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".mp4"));

          let videoMeta: VideoMetadata | null = null;
          if (isVideo) {
            try { videoMeta = await extractVideoMetadata(storedPath); } catch { /* ignore */ }
          }

          const [mediaRecord] = await db.insert(media).values({
            userId: hardcodedUserId,
            originalPath: storedPath,
            thumbnailPath: null,
            animatedThumbnailPath: animPath,
            previewPath: prevPath,
            status: isVideo ? "pending_video" : "pending",
            type: mediaType,
            fileName,
            mimeType,
            fileSize: length,
            shardPath: mediaShardPath(hardcodedUserId),
            metadata: { codec: videoMeta?.codec ?? "unknown" },
            width: videoMeta?.width ?? null,
            height: videoMeta?.height ?? null,
            duration: videoMeta?.duration ?? null,
          }).returning();

          if (!isVideo) {
            await enqueueThumbnailJob(mediaRecord.id, storedPath, thumbPath);
          } else {
            await enqueueVideoJob({
              jobId: "",
              mediaId: mediaRecord.id,
              originalPath: storedPath,
              thumbnailPath: thumbPath,
              animatedThumbnailPath: animPath,
              previewPath: prevPath,
              gpuEnabled: false,
            });
          }

          return reply.status(201).send({ results: [{ id: mediaRecord.id, status: mediaRecord.status }] });
        } catch (err) {
          request.log.error({ err }, "upload completion failed");
          return reply.status(500).send({ error: "upload completion failed" });
        }
      }

      const { fileName } = request.body as { fileName?: string };
      if (!fileName) {
        return reply.status(400).send({ error: "missing fileName" });
      }

      const storedFileName = generateFileName(fileName);
      const storedPath = originalPath(hardcodedUserId, storedFileName);

      try {
        let currentSize = 0;
        try { const s = await fs.stat(storedPath); currentSize = s.size; } catch { /* new file */ }

        if (currentSize !== offset) {
          return reply.status(409).send({ error: "offset mismatch" });
        }

        const chunk = request.body as Uint8Array;
        const buffer = Buffer.from(chunk);
        await fs.appendFile(storedPath, buffer);

        return reply.status(204).send();
      } catch (err) {
        request.log.error({ err }, "chunk write failed");
        return reply.status(500).send({ error: "chunk write failed" });
      }
    }

    const span = tracer.startSpan("media.upload");
    const startTime = Date.now();

    span.setAttributes({ "upload.user_id": hardcodedUserId });

    try {
      const parts = request.parts();
      const results: Array<{ id: string; status: string; fileName?: string }> = [];
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

        const [existing] = await db
          .select({ id: media.id })
          .from(media)
          .where(
            and(
              eq(media.userId, hardcodedUserId),
              eq(media.fileName, fileName),
              eq(media.fileSize, fileSize),
              isNull(media.deletedAt)
            )
          );

        if (existing) {
          fileSpan.setAttributes({ "media.duplicate": true });
          fileSpan.setStatus({ code: SpanStatusCode.OK });
          fileSpan.end();
          request.log.info({ mediaId: existing.id, fileName }, "duplicate upload skipped");
          results.push({ id: existing.id, status: "duplicate", fileName });
          continue;
        }

        let storedPath: string;
        let imgThumbPath: string;

        try {
          const storedFileName = generateFileName(fileName);
          storedPath = originalPath(hardcodedUserId, storedFileName);
          imgThumbPath = thumbnailPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".webp"));

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
            const jobId = await enqueueThumbnailJob(mediaRecord.id, storedPath, imgThumbPath);
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
          let videoMeta: VideoMetadata | null = null;
          try {
            videoMeta = await extractVideoMetadata(storedPath);
          } catch (err) {
            request.log.warn({ err, mediaId: mediaRecord.id }, "ffprobe failed");
          }

          const storedFileName = generateFileName(fileName);
          const animPath = animatedThumbnailPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".webm"));
          const prevPath = previewPath(hardcodedUserId, storedFileName.replace(/\.[^.]+$/, ".mp4"));

          await db.update(media).set({
            animatedThumbnailPath: animPath,
            previewPath: prevPath,
            width: videoMeta?.width ?? null,
            height: videoMeta?.height ?? null,
            duration: videoMeta?.duration ?? null,
            metadata: { codec: videoMeta?.codec ?? "unknown" },
          }).where(eq(media.id, mediaRecord.id));

          const jobSpan = tracer.startSpan("media.job.enqueue");
          jobSpan.setAttributes({ "media.id": mediaRecord.id, "job.type": "video" });

          try {
            const jobId = await enqueueVideoJob({
              jobId: "",
              mediaId: mediaRecord.id,
              originalPath: storedPath,
              thumbnailPath: imgThumbPath,
              animatedThumbnailPath: animPath,
              previewPath: prevPath,
              gpuEnabled: false,
            });
            jobSpan.setStatus({ code: SpanStatusCode.OK });
            jobSpan.end();
            request.log.info({ mediaId: mediaRecord.id, jobId }, "video job enqueued");
          } catch (err) {
            jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: "job enqueue failed" });
            jobSpan.end();
            uploadTotal.add(1, { type: mediaType, status: "error" });
            request.log.error({ err, mediaId: mediaRecord.id }, "job enqueue failed");
            await db.update(media).set({ status: "failed" }).where(eq(media.id, mediaRecord.id));
            errors.push({ fileName, error: "job enqueue failed" });
            continue;
          }
        }

        fileSpan.setStatus({ code: SpanStatusCode.OK });
        fileSpan.end();
        results.push({ id: mediaRecord.id, status: mediaRecord.status });
      }

      const hasSuccess = results.some((r) => r.status === "success");
      if (!hasSuccess && errors.length > 0) {
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
