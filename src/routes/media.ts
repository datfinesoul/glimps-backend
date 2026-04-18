import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { media } from "../db/schema.js";
import { eq, and, isNull, desc } from "drizzle-orm";

const hardcodedUserId = "00000000-0000-0000-0000-000000000000";

interface MediaListQuery {
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

export async function mediaRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: MediaListQuery }>("/api/media", async (request, reply) => {
    const page = Math.max(1, request.query.page ?? 1);
    const limit = Math.min(100, Math.max(1, request.query.limit ?? 30));
    const offset = (page - 1) * limit;

    const whereClause = and(
      eq(media.userId, hardcodedUserId),
      eq(media.status, "ready"),
      isNull(media.deletedAt)
    );

    const totalCountResult = await db
      .select({ count: media.id })
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
      data: rows,
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
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    };
    return reply.send(response);
  });
}