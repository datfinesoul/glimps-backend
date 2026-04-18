import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import pino from "pino";
import { loggerConfig } from "./logger.js";
import { env } from "./env.js";
import { healthRoute } from "./routes/health.js";
import { uploadRoute } from "./routes/upload.js";
import { mediaRoute } from "./routes/media.js";
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

  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_TIME_WINDOW_MS,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024,
    },
  });

  app.register(healthRoute);
  app.register(uploadRoute);
  app.register(mediaRoute);

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
