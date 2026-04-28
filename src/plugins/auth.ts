import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import { env } from "../env.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

async function authPluginInner(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
  });

  fastify.decorateRequest("userId", "");

  fastify.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const publicPaths = ["/api/auth/register", "/api/auth/login", "/api/auth/logout"];
    if (publicPaths.some((p) => request.url === p)) {
      return;
    }
    if (request.url === "/api/health") return;

    const token = request.cookies.token;
    if (!token) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    try {
      const decoded = await request.server.jwt.verify<{ userId: string; email: string }>(token);
      request.userId = decoded.userId;
    } catch {
      return reply.status(401).send({ error: "Session invalid or expired" });
    }
  });
}

export const authPlugin = fp(authPluginInner);