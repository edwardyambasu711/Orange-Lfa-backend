import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017"),
  MONGODB_DATABASE: z.string().default("orange_league"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(32).default("local-development-session-secret-change-me"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_EMAIL: z.string().email().default("orange.admin@orangefirstdivision.com"),
  ADMIN_PASSWORD: z.string().min(8).default("OrangeFDL@2026!"),
  ADMIN_NAME: z.string().default("Orange League Admin"),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
