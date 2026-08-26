import { MongoClient, type Db } from "mongodb";
import type { AppConfig } from "./config.js";

export type Database = {
  client: MongoClient;
  db: Db;
};

export async function connectDatabase(config: AppConfig): Promise<Database> {
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  return { client, db: client.db(config.MONGODB_DATABASE) };
}

export async function ensureIndexes(database: Database): Promise<void> {
  await Promise.all([
    database.db.collection("users").createIndex({ email: 1 }, { unique: true }),
    database.db.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true }),
    database.db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.db.collection("auditLogs").createIndex({ createdAt: -1 }),
  ]);
}
