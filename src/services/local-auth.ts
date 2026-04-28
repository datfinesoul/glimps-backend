import bcrypt from "bcrypt";
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SALT_ROUNDS = 10;

export interface AuthService {
  register(email: string, password: string): Promise<{ userId: string; email: string }>;
  login(email: string, password: string): Promise<{ userId: string; email: string }>;
  verifyToken(token: string, fastify: FastifyInstance): Promise<{ userId: string; email: string } | null>;
}

export class LocalAuthService implements AuthService {
  async register(email: string, password: string): Promise<{ userId: string; email: string }> {
    const existing = await db.select().from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      throw new Error("Email already registered");
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const [user] = await db.insert(users).values({ email, passwordHash }).returning();

    return { userId: user.id, email: user.email };
  }

  async login(email: string, password: string): Promise<{ userId: string; email: string }> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) throw new Error("Invalid credentials");

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new Error("Invalid credentials");

    return { userId: user.id, email: user.email };
  }

  async verifyToken(token: string, fastify: FastifyInstance): Promise<{ userId: string; email: string } | null> {
    try {
      const decoded = fastify.jwt.verify<{ userId: string; email: string }>(token);
      return { userId: decoded.userId, email: decoded.email };
    } catch {
      return null;
    }
  }
}