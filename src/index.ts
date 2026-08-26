import { buildApp } from "./app.js";
import { ensureAdminUser, ensureDemoTeamUsers } from "./auth.js";
import { loadConfig } from "./config.js";
import { connectDatabase, ensureIndexes } from "./db.js";

const config = loadConfig();
const database = await connectDatabase(config);
await ensureIndexes(database);
await ensureAdminUser(database, config);
await ensureDemoTeamUsers(database);

const app = await buildApp(database, config);
await app.listen({ host: config.API_HOST, port: config.API_PORT });

const shutdown = async () => {
  await app.close();
  await database.client.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
