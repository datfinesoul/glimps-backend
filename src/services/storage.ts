import { createHash } from "crypto";
import { join } from "path";
import { env } from "../env.js";

function computeShard(userId: string): string {
  const hash = createHash("sha256").update(userId).digest("hex");
  return hash.slice(0, 2);
}

export function mediaShardPath(userId: string): string {
  const shard = computeShard(userId);
  return join(shard, shard);
}

export function originalPath(userId: string, fileName: string): string {
  const shard = mediaShardPath(userId);
  return join(env.MEDIA_STORAGE_PATH, "originals", shard, fileName);
}

export function thumbnailPath(userId: string, fileName: string): string {
  const shard = mediaShardPath(userId);
  return join(env.MEDIA_STORAGE_PATH, "thumbnails", shard, fileName);
}

export function animatedThumbnailPath(userId: string, fileName: string): string {
  const shard = mediaShardPath(userId);
  return join(env.MEDIA_STORAGE_PATH, "animated", shard, fileName);
}

export function previewPath(userId: string, fileName: string): string {
  const shard = mediaShardPath(userId);
  return join(env.MEDIA_STORAGE_PATH, "previews", shard, fileName);
}

export function jobName(mediaId: string, jobType: string): string {
  return `media:${mediaId}:${jobType}`;
}