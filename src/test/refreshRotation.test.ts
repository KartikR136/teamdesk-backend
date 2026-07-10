import request from "supertest";
import { app } from "../app";
import { extractCookie } from "./testUtils";

describe("Refresh token rotation", () => {
  it("detects and blocks reuse of a rotated refresh token", async () => {
    // 1. Sign up, capture the ORIGINAL refresh token.
    const signupRes = await request(app).post("/api/auth/signup").send({
      email: "rotation@example.com",
      password: "password123",
      name: "Rotation Test",
    });

    const cookies = signupRes.headers["set-cookie"];

    const originalRefreshCookie = extractCookie(
      Array.isArray(cookies) ? cookies : [cookies],
      "refreshToken",
    );

    // 2. Use it once — this should succeed AND rotate (revoke old, issue new).
    const firstRefresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", [originalRefreshCookie]);

    expect(firstRefresh.status).toBe(200);

    // 3. Reuse the ORIGINAL (now-revoked) token — must be rejected.
    const secondRefresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", [originalRefreshCookie]);

    expect(secondRefresh.status).toBe(401);
  });
});
