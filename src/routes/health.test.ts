import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "../env.js";
import { healthRoute } from "./health.js";

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

describe("health route", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with status and timestamp", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("response matches schema", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.status).toBe("string");
    expect(body.status).toBe("ok");
  });
});

describe("rate limiting", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true,
      max: 5,
      timeWindow: 60000,
    });
    app.get("/under-limit", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows requests under the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: "GET",
        url: "/under-limit",
      });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe("rate limiting > 429", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true,
      max: 3,
      timeWindow: 60000,
    });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("blocks requests over the limit with 429", async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: "/test" });
    }

    const response = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(response.statusCode).toBe(429);
  });
});
