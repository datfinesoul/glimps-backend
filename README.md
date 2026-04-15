# Glimps Backend

Node.js API + BullMQ workers for the Glimps image library.

## Quick Start

```bash
# Copy and configure environment
cp .env.example .env

# Install dependencies
pnpm install

# Start infrastructure
docker compose up -d

# Run database migrations
(set -a && . .env && pnpm run db:push)

# Start dev server
(set -a && . .env && pnpm run dev)

# Start worker (separate terminal)
(set -a && . .env && pnpm run dev:worker)
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| API | 3000 | Fastify HTTP server |
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Job queue (BullMQ) |

## Testing "Works at All"

### Tool Requirements

- **node** >= 22
- **docker** — run postgres + redis locally
- **pnpm** — install dependencies

### Health Check

```bash
# Server must be running
curl http://localhost:3000/api/health
```

Expected: `{"status":"ok","timestamp":"..."}`

### Infrastructure

```bash
# View logs
docker compose logs -f

# Health checks
docker exec glimps_backend_postgres pg_isready -U glimps -d glimps
docker exec glimps_backend_redis redis-cli ping
```

### Lint / Typecheck / Test

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
```

## Production

```bash
pnpm run build
pm2 start ecosystem.config.js
```

Two processes: `glimps-web` (HTTP) and `glimps-worker` (BullMQ).

## Stopping

```bash
docker compose down        # preserve data
docker compose down -v     # destroy data
```
