import { describe, expect, it } from "vitest";
import { buildApp, syncDashboardNewsToSharedCollection } from "./app.js";
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
  it("syncs team dashboard articles into the shared news collection with team metadata", async () => {
    const writes: unknown[] = [];
    const database = {
      db: {
        collection: (name: string) => {
          if (name === "news") {
            return {
              updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
                writes.push({ name, filter, update });
                return { acknowledged: true };
              },
            };
          }

          return {
            insertOne: async (doc: unknown) => {
              writes.push({ name, doc });
              return { insertedId: "doc-1" };
            },
          };
        },
      },
    } as any;

    await syncDashboardNewsToSharedCollection(database, "team-42", {
      news: [
        {
          id: "news-1",
          title: "Club update",
          summary: "A short update",
          status: "Published",
          publishedAt: "2026-09-02T12:00:00.000Z",
          category: "Club",
          author: "Coach Smith",
          featured: true,
          tags: ["matchday"],
          at: "2026-09-02T12:00:00.000Z",
          updatedAt: "2026-09-02T12:00:00.000Z",
        },
      ],
    });

    expect(writes).toEqual([
      {
        name: "news",
        filter: { id: "news-1" },
        update: {
          $set: expect.objectContaining({
            id: "news-1",
            title: "Club update",
            teamId: "team-42",
            author: "Coach Smith",
            status: "Published",
            publishedAt: "2026-09-02T12:00:00.000Z",
          }),
          $setOnInsert: expect.objectContaining({
            createdAt: expect.any(Date),
          }),
        },
      },
    ]);
  });

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

  it("returns published news from the newsroom collection for the public API", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: (name: string) => {
            if (name === "news") {
              return {
                find: (filter: Record<string, unknown>) => ({
                  sort: () => ({
                    limit: () => ({
                      toArray: async () => {
                        const publishedOnly = Array.isArray((filter as any)?.status?.$in)
                          ? [
                              {
                                id: "news-1",
                                title: "League opener",
                                summary: "Kickoff is tomorrow.",
                                status: "Published",
                                publishedAt: "2026-09-02T12:00:00.000Z",
                                category: "General",
                                author: "League Desk",
                                featured: true,
                                tags: ["launch"],
                              },
                            ]
                          : [];
                        return publishedOnly;
                      },
                    }),
                  }),
                }),
              };
            }

            return {
              find: () => ({
                toArray: async () => [],
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
        publishedAt: "2026-09-02T12:00:00.000Z",
        category: "General",
        author: "League Desk",
        featured: true,
        tags: ["launch"],
      },
    ]);
  });
});
