import Fastify from "fastify";
import cors from "@fastify/cors";
import pino from "pino";
import { loggerConfig } from "./logger.js";
import { env } from "./env.js";
import { healthRoute } from "./routes/health.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry/index.js";

const fatalLog = pino({
  level: "fatal",
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
});

async function start(): Promise<void> {
  initTelemetry();

  const app = Fastify({
    logger: loggerConfig,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => crypto.randomUUID(),
  });

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
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  fatalLog.fatal({ err }, "fatal error starting server");
  process.exit(1);
});
