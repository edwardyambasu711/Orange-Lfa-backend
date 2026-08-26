import { ensureAdminUser, ensureDemoTeamUsers } from "./auth.js";
import { loadConfig } from "./config.js";
import { connectDatabase, ensureIndexes } from "./db.js";

const config = loadConfig();
const database = await connectDatabase(config);
await ensureIndexes(database);
await ensureAdminUser(database, config);
await ensureDemoTeamUsers(database);
console.log(`Seeded MongoDB database: ${config.MONGODB_DATABASE}`);
await database.client.close();
