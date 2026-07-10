import request from "supertest";
import { app } from "../app";

describe("Input validation", () => {
  it("rejects signup with an invalid email format", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "not-an-email",
      password: "password123",
      name: "Test",
    });
    expect(res.status).toBe(400);
  });

  it("rejects signup with a too-short password", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "short@example.com",
      password: "123",
      name: "Test",
    });
    expect(res.status).toBe(400);
  });
});
