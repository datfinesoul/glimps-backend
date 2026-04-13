import type { FastifyInstance, FastifySchema } from "fastify";

const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] },
    timestamp: { type: "string", format: "date-time" },
  },
  required: ["status", "timestamp"],
} as const;

const healthSchema: FastifySchema = {
  response: {
    200: healthResponseSchema,
  },
};

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/health", { schema: healthSchema }, async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });
}
