import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("provides safe local development defaults", () => {
    const config = loadConfig({});

    expect(config.MONGODB_DATABASE).toBe("orange_league");
    expect(config.API_PORT).toBe(4000);
    expect(config.NODE_ENV).toBe("development");
  });

  it("rejects an insecure session secret", () => {
    expect(() => loadConfig({ SESSION_SECRET: "too-short" })).toThrow();
  });
});
