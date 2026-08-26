import { describe, expect, it } from "vitest";
import { hashSessionToken } from "./auth.js";

describe("hashSessionToken", () => {
  it("is deterministic and does not expose the token", () => {
    const token = "example-session-token";
    const hash = hashSessionToken(token);

    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });
});
