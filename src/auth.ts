import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyRequest } from "fastify";
import type { Database } from "./db.js";
import type { AppConfig } from "./config.js";

export type AppRole =
  "super_admin" | "content_admin" | "match_operator" | "read_only_analyst" | "team_admin";

export type AuthUser = {
  id: string;
  email: string;
  fullName: string | null;
  roles: AppRole[];
  teamId?: string;
};

type UserDocument = AuthUser & { passwordHash: string; createdAt: Date; updatedAt: Date };

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function ensureAdminUser(database: Database, config: AppConfig): Promise<void> {
  const users = database.db.collection<UserDocument>("users");
  const existing = await users.findOne({ email: config.ADMIN_EMAIL.toLowerCase() });
  if (existing) return;

  await users.insertOne({
    id: randomBytes(16).toString("hex"),
    email: config.ADMIN_EMAIL.toLowerCase(),
    fullName: config.ADMIN_NAME,
    roles: ["super_admin"],
    passwordHash: await bcrypt.hash(config.ADMIN_PASSWORD, 12),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function ensureDemoTeamUsers(database: Database): Promise<void> {
  const users = database.db.collection<UserDocument>("users");
  const demoTeams = [
    ["admin@azulreal.fc", "AzulReal@2026", "Azul Real", "azul-real"],
    ["admin@ironvale.fc", "IronVale@2026", "Iron Vale United", "iron-vale"],
    ["admin@royalport.fc", "RoyalPort@2026", "Royal Port FC", "royal-port"],
    ["admin@northernstars.fc", "NorthernStars@2026", "Northern Stars", "northern-stars"],
  ] as const;

  for (const [email, password, fullName, teamId] of demoTeams) {
    const existing = await users.findOne({ email });
    if (existing) continue;
    await users.insertOne({
      id: randomBytes(16).toString("hex"),
      email,
      fullName,
      roles: ["team_admin"],
      teamId,
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

export async function createSession(
  database: Database,
  config: AppConfig,
  user: AuthUser,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await database.db
    .collection("sessions")
    .insertOne({ tokenHash: hashSessionToken(token), userId: user.id, expiresAt });
  return token;
}

export async function getSessionUser(
  database: Database,
  request: FastifyRequest,
): Promise<AuthUser | null> {
  const token = request.cookies.orange_league_session;
  if (!token) return null;

  const session = await database.db
    .collection<{ userId: string; expiresAt: Date }>("sessions")
    .findOne({
      tokenHash: hashSessionToken(token),
      expiresAt: { $gt: new Date() },
    });
  if (!session) return null;

  return database.db
    .collection<AuthUser>("users")
    .findOne(
      { id: session.userId },
      { projection: { _id: 0, id: 1, email: 1, fullName: 1, roles: 1, teamId: 1 } },
    );
}

export async function authenticateUser(
  database: Database,
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const user = await database.db
    .collection<UserDocument>("users")
    .findOne({ email: email.toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    roles: user.roles,
    teamId: user.teamId,
  };
}
