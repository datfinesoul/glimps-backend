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