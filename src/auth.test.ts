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
                        const publishedOnly = Array.isArray((filter as any)?.$or)
                          ? [
                              {
                                id: "news-1",
                                title: "League opener",
                                summary: "Kickoff is tomorrow.",
                                published_at: "2026-09-02T12:00:00.000Z",
                                category: "feature",
                                team_id: null,
                                body: "The season begins tomorrow.",
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
        published_at: "2026-09-02T12:00:00.000Z",
        category: "feature",
        team_id: null,
        body: "The season begins tomorrow.",
      },
    ]);
  });

  it("fetches a public player by id and returns not found for missing players", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: (name: string) => {
            if (name === "players") {
              return {
                findOne: async (filter: Record<string, unknown>) =>
                  filter.id === "player-1"
                    ? {
                        _id: "internal-id",
                        id: "player-1",
                        display_name: "Ada Stone",
                        first_name: "Ada",
                        last_name: "Stone",
                      }
                    : null,
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

    const found = await app.inject({ method: "GET", url: "/api/v1/public/players/player-1" });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({
      player: {
        id: "player-1",
        display_name: "Ada Stone",
        first_name: "Ada",
        last_name: "Stone",
      },
    });

    const missing = await app.inject({ method: "GET", url: "/api/v1/public/players/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
  });

  it("lists public players without soft-deleted records", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: (name: string) => {
            if (name === "players") {
              return {
                find: (filter: Record<string, unknown>) => {
                  expect(filter).toEqual({ deletedAt: { $exists: false } });
                  return {
                    limit: () => ({
                      toArray: async () => [
                        { _id: "internal-id", id: "player-1", display_name: "Ada Stone" },
                        { id: "player-2", display_name: "Kofi Mensah" },
                      ],
                    }),
                  };
                },
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

    const response = await app.inject({ method: "GET", url: "/api/v1/public/players" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "player-1", display_name: "Ada Stone" },
      { id: "player-2", display_name: "Kofi Mensah" },
    ]);
  });

  it("includes player logo URLs in leaders and top scorer responses", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: (name: string) => {
            if (name === "match_player_statistics") {
              return {
                find: () => ({
                  toArray: async () => [
                    { player_id: "player-1", goals: 4, assists: 2, clean_sheets: 1 },
                    { player_id: "player-2", goals: 1, assists: 3, clean_sheets: 0 },
                  ],
                }),
              };
            }
            if (name === "players") {
              return {
                find: () => ({
                  toArray: async () => [
                    { id: "player-1", display_name: "Ada Stone", logo_url: "https://example.com/ada.png" },
                    { id: "player-2", display_name: "Kofi Mensah", logoUrl: "https://example.com/kofi.png" },
                  ],
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

    const leaders = await app.inject({ method: "GET", url: "/api/v1/public/player-leaders" });
    expect(leaders.statusCode).toBe(200);
    expect(leaders.json()).toEqual(expect.objectContaining({
      goals: expect.arrayContaining([
        { playerId: "player-1", logoUrl: "https://example.com/ada.png", playerName: "Ada Stone", value: 4 },
      ]),
      assists: expect.arrayContaining([
        { playerId: "player-2", logoUrl: "https://example.com/kofi.png", playerName: "Kofi Mensah", value: 3 },
      ]),
    }));

    const topScorer = await app.inject({ method: "GET", url: "/api/v1/public/top-goal-scorer" });
    expect(topScorer.statusCode).toBe(200);
    expect(topScorer.json()).toMatchObject({
      playerId: "player-1",
      logoUrl: "https://example.com/ada.png",
    });
  });

  it("includes lineups and team form in the public match detail payload", async () => {
    const app = await buildApp(
      {
        client: {} as any,
        db: {
          command: async () => ({ ok: 1 }),
          collection: (name: string) => {
            if (name === "matches") {
              return {
                findOne: async () => ({
                  id: "match-1",
                  home_team_id: "home-team",
                  away_team_id: "away-team",
                  home_score: 2,
                  away_score: 1,
                  status: "live",
                  kickoff: "2026-09-02T18:00:00.000Z",
                }),
              };
            }
            if (name === "teams") {
              return {
                find: () => ({
                  toArray: async () => [
                    { id: "home-team", name: "Home FC", logo: "https://example.com/home.png" },
                    { id: "away-team", name: "Away FC", logo: "https://example.com/away.png" },
                  ],
                }),
              };
            }
            if (name === "match_events") {
              return {
                find: () => ({
                  sort: () => ({
                    toArray: async () => [],
                  }),
                }),
              };
            }
            if (name === "match_statistics") {
              return {
                find: () => ({
                  toArray: async () => [],
                }),
              };
            }
            if (name === "match_player_statistics") {
              return {
                find: () => ({
                  toArray: async () => [],
                }),
              };
            }
            if (name === "match_lineups") {
              return {
                find: () => ({
                  sort: () => ({
                    toArray: async () => [
                      {
                        id: "lineup-1",
                        match_id: "match-1",
                        team_id: "home-team",
                        player_id: "player-1",
                        is_starter: true,
                        minutes_played: 90,
                        position: "striker",
                      },
                    ],
                  }),
                }),
              };
            }
            if (name === "league_standings") {
              return {
                find: () => ({
                  toArray: async () => [
                    { team_id: "home-team", form: "WDDWL" },
                    { team_id: "away-team", form: "LWDWW" },
                  ],
                }),
              };
            }
            if (name === "players") {
              return {
                find: () => ({
                  toArray: async () => [
                    {
                      id: "player-1",
                      first_name: "Ada",
                      last_name: "Stone",
                      display_name: "Ada Stone",
                    },
                  ],
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

    const response = await app.inject({ method: "GET", url: "/api/v1/public/matches/match-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      match: {
        homeForm: ["W", "D", "D", "W", "L"],
        awayForm: ["L", "W", "D", "W", "W"],
      },
      lineups: [
        expect.objectContaining({
          id: "lineup-1",
          team: expect.objectContaining({ id: "home-team", name: "Home FC" }),
          player: expect.objectContaining({ id: "player-1", display_name: "Ada Stone" }),
        }),
      ],
    });
  });
});
