# Glimps Backend

Node.js API (Fastify) for the Glimps image library.

## Development

The harness repo (`glimps/`) runs all services via Docker Compose. See the harness [AGENTS.md](../AGENTS.md) for the standard development workflow.

**Quick start via harness:**
```bash
cd glimps
docker compose up -d
docker compose exec api pnpm run db:push
```

**Local iteration (debugging only):**
```bash
cp .env.example .env
pnpm install
(set -a && . .env && pnpm run dev)
```

## Commands

| Command | Context | Purpose |
|---------|---------|---------|
| `pnpm run lint` | docker exec or local | ESLint |
| `pnpm run typecheck` | docker exec or local | TypeScript |
| `pnpm run test` | docker exec or local | Vitest |
| `pnpm run db:push` | docker exec only | Push schema to database |
| `pnpm run build` | docker exec or local | tsc → dist/ |

**CI order**: lint → typecheck → test

## Entry Point

`src/server.ts` — Fastify HTTP server (port 3000)

## Stack

- Fastify + TypeScript
- Drizzle ORM + postgres
- BullMQ (via Redis)
- Pino (structured logging)
- OpenTelemetry (metrics + tracing)
- @fastify/multipart (file uploads)

## Debugging

### Database Access

```bash
# Connect to postgres
docker compose exec postgres psql -U glimps -d glimps
```

```sql
-- List all media
SELECT id, file_name, status, thumbnail_path, created_at FROM media;

-- View jobs queue
SELECT id, media_id, type, status, attempts, error FROM jobs ORDER BY created_at DESC LIMIT 20;

-- Clear all jobs (stuck or otherwise)
DELETE FROM jobs;

-- Delete all media and files (start fresh - requires deleting thumbnail/original files too)
DELETE FROM media;
```

### File Storage

```bash
# View media storage (thumbnails, originals)
docker compose exec api ls -la /app/media/

# Delete all media files (when starting fresh)
docker compose exec api rm -rf /app/media/thumbnails/*
docker compose exec api rm -rf /app/media/originals/*
```

### Worker Logs

```bash
# Follow worker output
docker compose logs -f worker
```

## Debug Endpoints

Internal endpoints for diagnosing upload and processing issues. These are not versioned and may change.

### `GET /debug/queues`

BullMQ queue depths — how many jobs are waiting, active, completed, failed.

```bash
curl http://localhost:3000/debug/queues
```

```json
{
  "data": {
    "thumbnail": { "waiting": 0, "active": 0, "completed": 12, "failed": 0, "delayed": 0 },
    "video": { "waiting": 0, "active": 1, "completed": 5, "failed": 2, "delayed": 0 }
  }
}
```

### `GET /debug/jobs`

All jobs (most recent first), optionally filtered by `?status=` or `?type=`.

```bash
curl "http://localhost:3000/debug/jobs?status=pending"
curl "http://localhost:3000/debug/jobs?type=video"
```

```json
{
  "data": [
    {
      "job": { "id": "...", "mediaId": "...", "type": "video", "status": "pending", "attempts": 0, "error": null },
      "media": { "id": "...", "fileName": "...", "type": "video", "status": "pending", "originalPath": "..." }
    }
  ]
}
```

### `GET /debug/media/pending`

All media not in `ready` state (stuck uploads, failed processing), optionally filtered by `?type=image` or `?type=video`.

```bash
curl "http://localhost:3000/debug/media/pending?type=video"
```

```json
{
  "data": [
    { "id": "...", "fileName": "...", "type": "video", "status": "pending", "originalPath": "...", "createdAt": "..." }
  ]
}
```

### Common Diagnoses

| Symptom | Check | Fix |
|---------|-------|-----|
| Upload says complete, no thumbnail | `GET /debug/media/pending` — media stuck in `pending` | Check `GET /debug/jobs` — if job missing, upload didn't enqueue |
| Job in `pending` but queue is empty | `GET /debug/queues` — `waiting` is 0 | Job was dropped or worker is down |
| Worker not processing | `docker compose logs -f worker` | Check for `stalled` errors, increase `lockDuration` |
| Media stuck in `pending`, job in `active` | Job stalled — exceeded lock duration | Restart worker to trigger `recoverStuckJobs` |