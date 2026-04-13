import { env } from "./env.js";

async function start(): Promise<void> {
  console.log(`[worker] starting (stub — no jobs defined yet)`);
  console.log(`[worker] redis: ${env.REDIS_URL}`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down`);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
