process.env.MEDIA_STORAGE_PATH = "/tmp/test-media";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "../env.js";

describe("CORS configuration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

    app = Fastify({ logger: false });
    await app.register(cors, {
      origin: allowedOrigins,
      credentials: true,
    });

    app.get("/test", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows requests from allowed origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        origin: "http://localhost:5173",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("denies requests from disallowed origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        origin: "http://malicious-site.com",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles multiple allowed origins", async () => {
    const response1 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "http://localhost:3000" },
    });

    const response2 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response1.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response2.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
