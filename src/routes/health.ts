import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });
}
