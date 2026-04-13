import Fastify from "fastify";
import { requestContext } from "@fastify/request-context";
import cors from "@fastify/cors";
import { loggerConfig } from "./logger.js";
import { env } from "./env.js";
import { healthRoute } from "./routes/health.js";

async function start(): Promise<void> {
  const app = Fastify({
    logger: loggerConfig,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(requestContext);
  await app.register(cors, { origin: true });

  app.register(healthRoute);

  app.addHook("onRequest", async (request) => {
    request.log.info(
      { method: request.method, url: request.url, requestId: request.id },
      "incoming request",
    );
  });

  const address = await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ address, env: env.NODE_ENV }, "server started");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
