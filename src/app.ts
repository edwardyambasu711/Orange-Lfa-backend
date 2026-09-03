import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { v2 as cloudinary } from "cloudinary";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  authenticateUser,
  createSession,
  getSessionUser,
  hashSessionToken,
  type AuthUser,
} from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { Database } from "./db.js";

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});

const mediaSchema = z.object({
  folder: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  data: z.string().startsWith("data:").max(15_000_000),
});

const resourceNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]*$/);

async function uploadMediaToCloudinary(
  config: AppConfig,
  data: string,
  folder: string,
  name: string,
  mimeType: string,
): Promise<string> {
  if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
    throw new Error("cloudinary_not_configured");
  }

  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });

  const normalizedFolder = [config.CLOUDINARY_FOLDER, folder].filter(Boolean).join("/");
  const resourceType = mimeType.startsWith("video/") ? "video" : "image";
  const publicId = name.replace(/\.[^/.]+$/, "") || "upload";

  const result = await cloudinary.uploader.upload(data, {
    folder: normalizedFolder,
    public_id: publicId,
    resource_type: resourceType,
    overwrite: false,
  });

  return result.secure_url;
}

function createCloudinaryUploadSignature(config: AppConfig, folder: string, fileName: string) {
  if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
    throw new Error("cloudinary_not_configured");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const normalizedFolder = [config.CLOUDINARY_FOLDER, folder].filter(Boolean).join("/");
  const publicId = fileName.replace(/\.[^/.]+$/, "") || "upload";
  const params = {
    folder: normalizedFolder,
    public_id: publicId,
    timestamp,
  };

  return {
    apiKey: config.CLOUDINARY_API_KEY,
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/auto/upload`,
    folder: normalizedFolder,
    publicId,
    resourceType: "auto",
    signature: cloudinary.utils.api_sign_request(params, config.CLOUDINARY_API_SECRET),
    timestamp,
  };
}

function publicDocument<T extends Record<string, unknown>>(document: T): T {
  const { _id: _ignored, ...rest } = document;
  return rest as T;
}

export async function syncDashboardNewsToSharedCollection(
  database: Database,
  teamId: string,
  dashboardData: Record<string, unknown>,
): Promise<void> {
  const items = Array.isArray((dashboardData as Record<string, any>).news)
    ? ((dashboardData as Record<string, any>).news as Record<string, any>[])
    : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const record = {
      ...item,
      id: item.id ?? `news-${randomUUID()}`,
      teamId,
      author: item.author ?? "Unknown author",
      status: item.status ?? "Draft",
      publishedAt: item.publishedAt ?? item.updatedAt ?? item.at ?? new Date().toISOString(),
      updatedAt: item.updatedAt ?? item.at ?? new Date().toISOString(),
      createdAt: item.createdAt ?? new Date(),
    };

    await database.db.collection("news").updateOne(
      { id: record.id },
      {
        $set: record,
        $setOnInsert: { createdAt: record.createdAt },
      },
      { upsert: true },
    );
  }
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

export async function buildApp(
  database: Database,
  config: AppConfig = loadConfig(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(cors, {
    origin: [
      config.FRONTEND_ORIGIN,
      "https://orange-league-control.vercel.app",
      "https://test-lac-pi-18.vercel.app",
    ],
    credentials: true,
  });
  await app.register(websocket);

  app.decorateRequest("authUser", null);
  app.addHook("preHandler", async (request) => {
    request.authUser = await getSessionUser(database, request);
  });

  app.get("/health", async () => ({ status: "ok", service: "orange-league-api" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await database.db.command({ ping: 1 });
      return { status: "ready", database: "connected" };
    } catch {
      return reply.code(503).send({ status: "not_ready", database: "unavailable" });
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });

    const user = await authenticateUser(database, parsed.data.email, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "invalid_credentials" });

    const token = await createSession(database, config, user);
    reply.setCookie("orange_league_session", token, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: config.NODE_ENV === "production" ? "none" : "lax",
      path: "/",
      maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60,
    });
    return { user };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies.orange_league_session;
    if (token)
      await database.db.collection("sessions").deleteOne({ tokenHash: hashSessionToken(token) });
    reply.clearCookie("orange_league_session", { path: "/" });
    return { success: true };
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
    return { user: request.authUser };
  });

  app.post("/api/v1/media/signature", async (request, reply) => {
    const parsed = z
      .object({
        folder: z.string().min(1).max(100).default(""),
        name: z.string().min(1).max(255),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      return createCloudinaryUploadSignature(config, parsed.data.folder, parsed.data.name);
    } catch (error) {
      return reply.code(500).send({
        error: "media_upload_failed",
        details: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  app.post("/api/v1/media", async (request, reply) => {
    const parsed = mediaSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });

    try {
      const secureUrl = await uploadMediaToCloudinary(
        config,
        parsed.data.data,
        parsed.data.folder,
        parsed.data.name,
        parsed.data.type,
      );

      const mediaId = randomUUID();
      const ownerId = request.authUser?.id ?? "public-upload";
      await database.db.collection("media").insertOne({
        id: mediaId,
        ownerId,
        folder: parsed.data.folder,
        name: parsed.data.name,
        type: parsed.data.type,
        url: secureUrl,
        createdAt: new Date(),
      });

      return { id: mediaId, url: secureUrl };
    } catch (error) {
      return reply.code(500).send({
        error: "media_upload_failed",
        details: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  app.get<{ Params: { teamId: string } }>(
    "/api/v1/public/teams/:teamId/dashboard",
    async (request, reply) => {
      const dashboard = await database.db
        .collection("teamDashboards")
        .findOne({ teamId: request.params.teamId });
      if (!dashboard) return reply.code(404).send({ error: "not_found" });
      const data = dashboard.data as Record<string, any>;
      return {
        ...data,
        news: Array.isArray(data.news)
          ? data.news.filter((item) => item.status === "Published")
          : [],
        pages: Array.isArray(data.pages) ? data.pages.filter((page) => page.published) : [],
      };
    },
  );

  app.get("/api/v1/public/teams", async () => {
    const rows = await database.db
      .collection("teams")
      .find({ deletedAt: { $exists: false } })
      .limit(1000)
      .toArray();
    return rows.map((row) => publicDocument(row));
  });

  app.get("/api/v1/public/matches", async () => {
    const rows = await database.db
      .collection("matches")
      .find({ deletedAt: { $exists: false } })
      .sort({ kickoff: 1 })
      .limit(1000)
      .toArray();
    return rows.map((row) => publicDocument(row));
  });

  app.get("/api/v1/public/standings", async () => {
    const rows = await database.db
      .collection("standings")
      .find({ deletedAt: { $exists: false } })
      .sort({ position: 1 })
      .limit(1000)
      .toArray();
    return rows.map((row) => publicDocument(row));
  });

  app.get("/api/v1/public/news", async () => {
    const rows = await database.db
      .collection("news")
      .find({
        deletedAt: { $exists: false },
        $or: [
          { status: { $in: ["Published", "published"] } },
          { published_at: { $exists: true, $ne: null } },
          { publishedAt: { $exists: true, $ne: null } },
        ],
      })
      .sort({ published_at: -1, publishedAt: -1, createdAt: -1 })
      .limit(1000)
      .toArray();

    if (rows.length > 0) return rows.map((row) => publicDocument(row));

    const dashboards = await database.db.collection("teamDashboards").find({}).toArray();
    const legacyRows = dashboards.flatMap((dashboard) => {
      const data = (dashboard.data ?? {}) as Record<string, any>;
      const items = Array.isArray(data.news) ? data.news : [];

      return items
        .filter((item) => item && (item.status === "Published" || item.status === "published"))
        .map((item) => ({
          ...item,
          teamId: dashboard.teamId,
          publishedAt: item.publishedAt ?? item.updatedAt ?? item.at ?? new Date().toISOString(),
        }));
    });

    legacyRows.sort((a, b) => {
      const aDate = new Date(a.publishedAt ?? a.updatedAt ?? a.at ?? 0).getTime();
      const bDate = new Date(b.publishedAt ?? b.updatedAt ?? b.at ?? 0).getTime();
      return bDate - aDate;
    });

    return legacyRows.slice(0, 1000).map((row) => publicDocument(row));
  });

  app.get<{
    Params: { resource: string };
    Querystring: { search?: string; sort?: string; direction?: string };
  }>("/api/v1/admin/:resource", async (request, reply) => {
    const resource = resourceNameSchema.safeParse(request.params.resource);
    if (!resource.success) return reply.code(400).send({ error: "invalid_resource" });

    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (request.query.search) {
      filter.$or = [
        { name: { $regex: request.query.search, $options: "i" } },
        { title: { $regex: request.query.search, $options: "i" } },
        { displayName: { $regex: request.query.search, $options: "i" } },
      ];
    }
    const sort = request.query.sort
      ? { [request.query.sort]: (request.query.direction === "desc" ? -1 : 1) as 1 | -1 }
      : { createdAt: -1 as const };
    const rows = await database.db
      .collection(resource.data)
      .find(filter)
      .sort(sort)
      .limit(1000)
      .toArray();
    return rows.map((row) => publicDocument(row));
  });

  app.post<{ Params: { resource: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/:resource",
    async (request, reply) => {
      if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
      if (
        !request.authUser.roles.includes("super_admin") &&
        !request.authUser.roles.includes("content_admin")
      ) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const resource = resourceNameSchema.safeParse(request.params.resource);
      if (!resource.success) return reply.code(400).send({ error: "invalid_resource" });
      const now = new Date();
      const document = {
        ...request.body,
        id: request.body.id ?? crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      await database.db.collection(resource.data).insertOne(document);
      return reply.code(201).send(publicDocument(document));
    },
  );

  app.patch<{ Params: { resource: string; id: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/:resource/:id",
    async (request, reply) => {
      if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
      if (
        !request.authUser.roles.includes("super_admin") &&
        !request.authUser.roles.includes("content_admin")
      ) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const resource = resourceNameSchema.safeParse(request.params.resource);
      if (!resource.success) return reply.code(400).send({ error: "invalid_resource" });
      const update = { ...request.body, updatedAt: new Date() };
      const result = await database.db
        .collection(resource.data)
        .findOneAndUpdate({ id: request.params.id }, { $set: update }, { returnDocument: "after" });
      if (!result) return reply.code(404).send({ error: "not_found" });
      return publicDocument(result);
    },
  );

  app.delete<{ Params: { resource: string; id: string } }>(
    "/api/v1/admin/:resource/:id",
    async (request, reply) => {
      if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
      if (!request.authUser.roles.includes("super_admin"))
        return reply.code(403).send({ error: "forbidden" });
      const resource = resourceNameSchema.safeParse(request.params.resource);
      if (!resource.success) return reply.code(400).send({ error: "invalid_resource" });
      await database.db
        .collection(resource.data)
        .updateOne(
          { id: request.params.id },
          { $set: { deletedAt: new Date(), updatedAt: new Date() } },
        );
      return { success: true };
    },
  );

  app.get<{ Querystring: { teamId?: string } }>(
    "/api/v1/team/dashboard",
    async (request, reply) => {
      if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
      const teamId = request.query.teamId ?? request.authUser.teamId;
      if (
        !teamId ||
        (request.authUser.roles.includes("team_admin") && request.authUser.teamId !== teamId)
      ) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const dashboard = await database.db.collection("teamDashboards").findOne({ teamId });
      if (!dashboard) return reply.code(404).send({ error: "not_found" });
      return dashboard.data;
    },
  );

  app.put<{ Body: { teamId: string; data: Record<string, unknown>; action?: string } }>(
    "/api/v1/team/dashboard",
    async (request, reply) => {
      if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
      const { teamId, data, action = "Updated team dashboard" } = request.body;
      if (request.authUser.roles.includes("team_admin") && request.authUser.teamId !== teamId) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await database.db.collection("teamDashboards").updateOne(
        { teamId },
        {
          $set: { teamId, data, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      await syncDashboardNewsToSharedCollection(database, teamId, data as Record<string, unknown>);

      await database.db
        .collection("auditLogs")
        .insertOne({ teamId, action, actor: request.authUser.email, createdAt: new Date() });
      return data;
    },
  );

  app.get<{ Querystring: { teamId?: string } }>("/api/v1/team/audit", async (request, reply) => {
    if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
    const teamId = request.query.teamId ?? request.authUser.teamId;
    if (
      !teamId ||
      (request.authUser.roles.includes("team_admin") && request.authUser.teamId !== teamId)
    ) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const logs = await database.db
      .collection("auditLogs")
      .find({ teamId })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();
    return logs.map((log) => ({
      id: String(log._id),
      action: log.action,
      actor: log.actor,
      at: log.createdAt,
    }));
  });

  app.get("/api/v1/ws", { websocket: true }, (socket) => {
    socket.send(
      JSON.stringify({
        type: "connected",
        message: "Match rooms will be enabled in the match-center phase.",
      }),
    );
  });

  return app;
}
