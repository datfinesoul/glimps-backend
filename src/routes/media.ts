import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { media, jobs } from "../db/schema.js";
import { eq, and, isNull, isNotNull, desc, count, gte, lte, ilike } from "drizzle-orm";
import { env } from "../env.js";
import { unlink } from "fs/promises";

const hardcodedUserId = "00000000-0000-0000-0000-000000000000";

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

interface MediaSearchQuery {
  q: string;
  page?: number;
  limit?: number;
  type?: "image" | "video";
  dateFrom?: string;
  dateTo?: string;
}

interface TrashListQuery {
  page?: number;
  limit?: number;
}

interface MediaListResponse {
  data: Array<{
    id: string;
    thumbnailPath: string | null;
    previewPath: string | null;
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

interface MediaDetailResponse {
  id: string;
  originalPath: string | null;
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
  metadata: Record<string, unknown>;
  favorited: boolean;
  sensitive: boolean;
  createdAt: Date;
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

  app.get<{ Params: { id: string } }>("/api/media/:id", async (request, reply) => {
    const { id } = request.params;

    const [row] = await db
      .select({
        id: media.id,
        originalPath: media.originalPath,
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
        metadata: media.metadata,
        favorited: media.favorited,
        sensitive: media.sensitive,
        createdAt: media.createdAt,
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

    const response: MediaDetailResponse = {
      ...row,
      originalPath: toUrlPath(row.originalPath),
      thumbnailPath: toUrlPath(row.thumbnailPath),
      previewPath: toUrlPath(row.previewPath),
      animatedThumbnailPath: toUrlPath(row.animatedThumbnailPath),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    };
    return reply.send(response);
  });

  app.get<{ Querystring: MediaSearchQuery }>("/api/media/search", async (request, reply) => {
    const { q } = request.query;

    if (!q || !q.trim()) {
      return reply.status(400).send({ error: "q query parameter is required" });
    }

    const page = Math.max(1, request.query.page ?? 1);
    const limit = Math.min(100, Math.max(1, request.query.limit ?? 30));
    const offset = (page - 1) * limit;
    const searchPattern = `%${q.trim()}%`;

    const conditions = [
      eq(media.userId, hardcodedUserId),
      eq(media.status, "ready"),
      isNull(media.deletedAt),
      ilike(media.fileName, searchPattern),
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

  app.delete<{ Params: { id: string } }>("/api/media/:id", async (request, reply) => {
    const { id } = request.params;

    const [row] = await db
      .select({ id: media.id })
      .from(media)
      .where(and(
        eq(media.id, id),
        eq(media.userId, hardcodedUserId),
        isNull(media.deletedAt)
      ));

    if (!row) {
      return reply.status(404).send({ error: "media not found" });
    }

    await db
      .update(media)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(media.id, id),
        eq(media.userId, hardcodedUserId)
      ));

    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/media/:id/restore", async (request, reply) => {
    const { id } = request.params;

    const [row] = await db
      .select({ id: media.id })
      .from(media)
      .where(and(
        eq(media.id, id),
        eq(media.userId, hardcodedUserId),
        isNotNull(media.deletedAt)
      ));

    if (!row) {
      return reply.status(404).send({ error: "media not found" });
    }

    await db
      .update(media)
      .set({ deletedAt: null })
      .where(and(
        eq(media.id, id),
        eq(media.userId, hardcodedUserId)
      ));

    return reply.status(204).send();
  });

  app.get<{ Querystring: TrashListQuery }>("/api/media/trash", async (request, reply) => {
    const page = Math.max(1, request.query.page ?? 1);
    const limit = Math.min(100, Math.max(1, request.query.limit ?? 30));
    const offset = (page - 1) * limit;

    const whereClause = and(
      eq(media.userId, hardcodedUserId),
      isNotNull(media.deletedAt)
    );

    const totalCountResult = await db
      .select({ count: count() })
      .from(media)
      .where(whereClause);

    const totalItems = Number(totalCountResult[0]?.count ?? 0);
    const totalPages = Math.ceil(totalItems / limit);

    const rows = await db
      .select({
        id: media.id,
        originalPath: media.originalPath,
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
        deletedAt: media.deletedAt,
      })
      .from(media)
      .where(whereClause)
      .orderBy(desc(media.deletedAt))
      .limit(limit)
      .offset(offset);

    return reply.send({
      data: rows.map((row) => ({
        ...row,
        originalPath: toUrlPath(row.originalPath),
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
    });
  });

  app.delete<{ Params: { id: string } }>("/api/media/:id/permanent", async (request, reply) => {
    const { id } = request.params;

    const [row] = await db
      .select({
        id: media.id,
        originalPath: media.originalPath,
        thumbnailPath: media.thumbnailPath,
        previewPath: media.previewPath,
        animatedThumbnailPath: media.animatedThumbnailPath,
      })
      .from(media)
      .where(and(
        eq(media.id, id),
        eq(media.userId, hardcodedUserId),
        isNotNull(media.deletedAt)
      ));

    if (!row) {
      return reply.status(404).send({ error: "media not found" });
    }

    await db.delete(jobs).where(eq(jobs.mediaId, id));
    await deleteMediaFiles(row);
    await db.delete(media).where(eq(media.id, id));

    return reply.status(204).send();
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
