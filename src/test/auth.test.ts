import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";

describe("Signup", () => {
  it("rejects signup with an already-used email", async () => {
    await request(app).post("/api/auth/signup").send({
      email: "dup@example.com",
      password: "password123",
      name: "First",
    });

    const res = await request(app).post("/api/auth/signup").send({
      email: "dup@example.com",
      password: "differentpass",
      name: "Second",
    });

    expect(res.status).toBe(400);
  });
});

describe("Login", () => {
  beforeEach(async () => {
    await request(app).post("/api/auth/signup").send({
      email: "user@example.com",
      password: "correctpassword",
      name: "Test User",
    });
  });

  it("returns the same error for wrong password vs nonexistent email (enumeration protection)", async () => {
    const wrongPassword = await request(app).post("/api/auth/login").send({
      email: "user@example.com",
      password: "wrongpassword",
    });

    const nonexistentEmail = await request(app).post("/api/auth/login").send({
      email: "doesnotexist@example.com",
      password: "whatever",
    });

    expect(wrongPassword.status).toBe(401);
    expect(nonexistentEmail.status).toBe(401);
    expect(wrongPassword.body.error).toBe(nonexistentEmail.body.error);
  });
});

describe("Protected route access", () => {
  it("rejects requests with no access token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a tampered token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", ["accessToken=this.is.not.a.valid.jwt"]);
    expect(res.status).toBe(401);
  });
});
