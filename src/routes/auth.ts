import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { LocalAuthService, type AuthService } from "../services/local-auth.js";

const authService: AuthService = new LocalAuthService();

interface CookieOptions {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  maxAge: number;
}

const COOKIE_OPTIONS: CookieOptions = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60,
};

interface RegisterBody {
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

type SetCookieFn = (name: string, value: string, options: CookieOptions) => void;
type ClearCookieFn = (name: string, options: { path: string }) => void;

function setTokenCookie(reply: { setCookie: SetCookieFn }, token: string): void {
  reply.setCookie("token", token, COOKIE_OPTIONS);
}

function clearTokenCookie(reply: { clearCookie: ClearCookieFn }): void {
  reply.clearCookie("token", { path: "/" });
}

export async function authRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterBody }>("/api/auth/register", async (request, reply) => {
    const { email, password } = request.body ?? {};

    if (!email || !password) {
      return reply.status(400).send({ error: "Email and password are required" });
    }

    if (password.length < 8) {
      return reply.status(400).send({ error: "Password must be at least 8 characters" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return reply.status(400).send({ error: "Invalid email format" });
    }

    try {
      const user = await authService.register(email, password);
      const token = reply.server.jwt.sign({ userId: user.userId, email: user.email });
      setTokenCookie(reply, token);
      return reply.status(201).send({ id: user.userId, email: user.email });
    } catch (err) {
      if (err instanceof Error && err.message === "Email already registered") {
        return reply.status(409).send({ error: err.message });
      }
      request.log.error({ err }, "registration failed");
      return reply.status(500).send({ error: "Registration failed" });
    }
  });

  app.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const { email, password } = request.body ?? {};

    if (!email || !password) {
      return reply.status(400).send({ error: "Email and password are required" });
    }

    try {
      const user = await authService.login(email, password);
      const token = reply.server.jwt.sign({ userId: user.userId, email: user.email });
      setTokenCookie(reply, token);
      return reply.status(200).send({ id: user.userId, email: user.email });
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid credentials") {
        return reply.status(401).send({ error: "Invalid credentials" });
      }
      request.log.error({ err }, "login failed");
      return reply.status(500).send({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    clearTokenCookie(reply);
    return reply.status(200).send({ message: "Logged out" });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const token = request.cookies.token;
    if (!token) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    const decoded = await authService.verifyToken(token, reply.server);
    if (!decoded) {
      return reply.status(401).send({ error: "Session invalid or expired" });
    }

    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, decoded.userId));
    if (!user) {
      return reply.status(401).send({ error: "User not found" });
    }

    return reply.send({ id: user.id, email: user.email });
  });
}