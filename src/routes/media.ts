import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { media, jobs } from "../db/schema.js";
import { eq, and, isNull, isNotNull, desc, count, gte, lte } from "drizzle-orm";
import { env } from "../env.js";
import { unlink } from "fs/promises";
import { createReadStream } from "fs";
import * as path from "path";

const hardcodedUserId = "00000000-0000-0000-0000-000000000000";

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

function toUrlPath(filesystemPath: string | null): string | null {
  if (!filesystemPath) return null;
  const normalizedPath = filesystemPath.replace(/\\/g, "/");
  const urlPath = normalizedPath.replace(env.MEDIA_STORAGE_PATH, "");
  const cleanPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return `/media${cleanPath}`;
}

interface MediaListQuery {
  page?: number;
  limit?: number;
  type?: "image" | "video";
  dateFrom?: string;
  dateTo?: string;
}

interface MediaListResponse {
  data: Array<{
    id: string;
    thumbnailPath: string | null;
    previewPath: string | null;
    animatedThumbnailPath: string | null;
    type: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    width: number | null;
    height: number | null;
    duration: number | null;
    favorited: boolean;
    sensitive: boolean;
    createdAt: Date;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

async function deleteMediaFiles(row: {
  originalPath: string | null;
  thumbnailPath: string | null;
  previewPath: string | null;
  animatedThumbnailPath: string | null;
}): Promise<void> {
  const paths = [
    row.originalPath,
    row.thumbnailPath,
    row.previewPath,
    row.animatedThumbnailPath,
  ];
  await Promise.allSettled(
    paths.map((p) => (p ? unlink(p).catch(() => {}) : Promise.resolve()))
  );
}

export async function mediaRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: MediaListQuery }>("/api/media", async (request, reply) => {
    const page = Math.max(1, request.query.page ?? 1);
    const limit = Math.min(100, Math.max(1, request.query.limit ?? 30));
    const offset = (page - 1) * limit;

    const conditions = [
      eq(media.userId, hardcodedUserId),
      eq(media.status, "ready"),
      isNull(media.deletedAt),
    ];

    if (request.query.type === "image") {
      conditions.push(eq(media.type, "image"));
    } else if (request.query.type === "video") {
      conditions.push(eq(media.type, "video"));
    }

    if (request.query.dateFrom) {
      const from = new Date(request.query.dateFrom);
      if (!isNaN(from.getTime())) {
        conditions.push(gte(media.createdAt, from));
      }
    }

    if (request.query.dateTo) {
      const to = new Date(request.query.dateTo);
      if (!isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        conditions.push(lte(media.createdAt, to));
      }
    }

    const whereClause = and(...conditions);

    const totalCountResult = await db
      .select({ count: count() })
      .from(media)
      .where(whereClause);

    const totalItems = Number(totalCountResult[0]?.count ?? 0);
    const totalPages = Math.ceil(totalItems / limit);

    const rows = await db
      .select({
        id: media.id,
        thumbnailPath: media.thumbnailPath,
        previewPath: media.previewPath,
        animatedThumbnailPath: media.animatedThumbnailPath,
        type: media.type,
        fileName: media.fileName,
        mimeType: media.mimeType,
        fileSize: media.fileSize,
        width: media.width,
        height: media.height,
        duration: media.duration,
        favorited: media.favorited,
        sensitive: media.sensitive,
        createdAt: media.createdAt,
      })
      .from(media)
      .where(whereClause)
      .orderBy(desc(media.createdAt))
      .limit(limit)
      .offset(offset);

    const response: MediaListResponse = {
      data: rows.map((row) => ({
        ...row,
        thumbnailPath: toUrlPath(row.thumbnailPath),
        previewPath: toUrlPath(row.previewPath),
        animatedThumbnailPath: toUrlPath(row.animatedThumbnailPath),
      })),
      pagination: {
        page,
        limit,
        total: totalItems,
        totalPages,
      },
    };

return reply.send(response);
  });

  app.get<{ Params: { id: string } }>("/api/media/:id/stream", async (request, reply) => {
    const { id } = request.params;

    const [row] = await db
      .select({
        previewPath: media.previewPath,
        originalPath: media.originalPath,
        mimeType: media.mimeType,
        type: media.type,
      })
      .from(media)
      .where(and(
        eq(media.id, id),
        eq(media.userId, hardcodedUserId),
        isNull(media.deletedAt)
      ));

    if (!row) {
      return reply.status(404).send({ error: "media not found" });
    }

    const filePath = row.previewPath || row.originalPath;
    if (!filePath) {
      return reply.status(404).send({ error: "file not found" });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeFromPath(ext) || "application/octet-stream";

    const stat = await import("fs/promises").then(fs => fs.stat(filePath));
    const fileSize = stat.size;

    const range = request.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace("bytes=", "").split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      reply.header("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Length", String(chunkSize));
      reply.status(206);

      return reply.type(contentType).send(createReadStream(filePath, { start, end }));
    }

    reply.header("Content-Length", String(fileSize));
    reply.header("Accept-Ranges", "bytes");
    return reply.type(contentType).send(createReadStream(filePath));
  });

  app.delete("/api/media/trash", async (request, reply) => {
    const whereClause = and(
      eq(media.userId, hardcodedUserId),
      isNotNull(media.deletedAt)
    );

    const rows = await db
      .select({
        id: media.id,
        originalPath: media.originalPath,
        thumbnailPath: media.thumbnailPath,
        previewPath: media.previewPath,
        animatedThumbnailPath: media.animatedThumbnailPath,
      })
      .from(media)
      .where(whereClause);

    await Promise.all(rows.map((row) => db.delete(jobs).where(eq(jobs.mediaId, row.id))));
    await Promise.all(rows.map((row) => deleteMediaFiles(row)));
    await db.delete(media).where(whereClause);

    return reply.status(204).send();
  });
}
