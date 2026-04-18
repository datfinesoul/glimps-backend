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

-- Reset all thumbnails for regeneration (e.g., after format change)
UPDATE media SET thumbnail_path = NULL, status = 'pending' WHERE deleted_at IS NULL;

-- View jobs queue
SELECT id, media_id, type, status, attempts, error FROM jobs ORDER BY created_at DESC LIMIT 20;

-- Clear stuck/failed jobs
DELETE FROM jobs WHERE status = 'failed';
```

### File Storage

```bash
# View media storage (thumbnails, originals)
docker compose exec api ls -la /app/media/

# Delete all thumbnails (force regeneration)
docker compose exec api rm -rf /app/media/thumbnails/*
```

### Worker Logs

```bash
# Follow worker output
docker compose logs -f worker
```