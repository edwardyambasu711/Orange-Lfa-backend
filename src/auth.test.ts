import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { hashSessionToken } from "./auth.js";
import { loadConfig } from "./config.js";

describe("hashSessionToken", () => {
  it("is deterministic and does not expose the token", () => {
    const token = "example-session-token";
    const hash = hashSessionToken(token);

    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });
});

describe("public API routes", () => {
  it("allows unauthenticated access to admin resources", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: () => ({
            find: () => ({
              sort: () => ({
                limit: () => ({
                  toArray: async () => [],
                }),
              }),
            }),
          }),
        },
      } as any,
      loadConfig({ SESSION_SECRET: "local-development-session-secret-change-me" }),
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/news" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns published news from team dashboards for the public API", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: (name: string) => {
            if (name !== "teamDashboards") {
              return {
                find: () => ({
                  sort: () => ({
                    limit: () => ({ toArray: async () => [] }),
                  }),
                }),
              };
            }

            return {
              find: () => ({
                toArray: async () => [
                  {
                    teamId: "azul-real",
                    data: {
                      news: [
                        {
                          id: "news-1",
                          title: "League opener",
                          summary: "Kickoff is tomorrow.",
                          status: "Published",
                          at: "2026-09-02T12:00:00.000Z",
                          updatedAt: "2026-09-02T12:00:00.000Z",
                          category: "General",
                          author: "League Desk",
                          featured: true,
                          tags: ["launch"],
                        },
                        {
                          id: "news-2",
                          title: "Draft update",
                          status: "Draft",
                        },
                      ],
                    },
                  },
                ],
              }),
            };
          },
        },
      } as any,
      loadConfig({ SESSION_SECRET: "local-development-session-secret-change-me" }),
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/public/news" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: "news-1",
        title: "League opener",
        summary: "Kickoff is tomorrow.",
        status: "Published",
        at: "2026-09-02T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:00.000Z",
        category: "General",
        author: "League Desk",
        featured: true,
        tags: ["launch"],
        teamId: "azul-real",
        publishedAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
  });
});
