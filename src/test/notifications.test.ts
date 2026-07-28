import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { notify } from "../lib/notifications";
import { extractCookie } from "./testUtils";

async function signupAndLogin(email: string): Promise<{ cookie: string; userId: string }> {
  const signupRes = await request(app).post("/api/auth/signup").send({
    email,
    password: "correctpassword",
    name: "Test User",
  });

  const loginRes = await request(app).post("/api/auth/login").send({
    email,
    password: "correctpassword",
  });

  const setCookie = loginRes.headers["set-cookie"];
  if (!setCookie) {
    throw new Error(`Login for ${email} returned no set-cookie header.`);
  }

  return {
    cookie: extractCookie(setCookie, "accessToken"),
    userId: signupRes.body.id ?? loginRes.body.user?.id,
  };
}

async function createOrg(cookie: string, name: string): Promise<string> {
  const res = await request(app)
    .post("/api/organizations")
    .set("Cookie", [cookie])
    .send({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  return res.body.id as string;
}

describe("notifications", () => {
  it("lists, counts, marks read, marks all read, and deletes only the caller's own notifications", async () => {
    const a = await signupAndLogin("notif-a@example.com");
    const b = await signupAndLogin("notif-b@example.com");
    const orgId = await createOrg(a.cookie, "notif-org");

    // Seed three notifications for user A directly via the lib function
    // (mirrors how every route handler in the app triggers notify()).
    await notify({
      recipientId: a.userId,
      organizationId: orgId,
      type: "MENTION",
      message: "mentioned you in a comment",
    });
    await notify({
      recipientId: a.userId,
      organizationId: orgId,
      type: "ASSIGNMENT",
      message: "assigned you an issue",
    });
    await notify({
      recipientId: b.userId,
      organizationId: orgId,
      type: "MENTION",
      message: "mentioned you too",
    });

    // Unread count is scoped to the caller.
    const countRes = await request(app)
      .get("/api/notifications/unread-count")
      .set("Cookie", [a.cookie]);
    expect(countRes.status).toBe(200);
    expect(countRes.body.count).toBe(2);

    // List returns only A's notifications, newest first.
    const listRes = await request(app)
      .get("/api/notifications")
      .set("Cookie", [a.cookie]);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(2);
    expect(
      listRes.body.data.every((n: { id: string }) => typeof n.id === "string"),
    ).toBe(true);

    const targetId = listRes.body.data[0].id as string;

    // B cannot mark A's notification read.
    const crossUserRes = await request(app)
      .patch(`/api/notifications/${targetId}/read`)
      .set("Cookie", [b.cookie]);
    expect(crossUserRes.status).toBe(404);

    // A can mark their own notification read.
    const markRes = await request(app)
      .patch(`/api/notifications/${targetId}/read`)
      .set("Cookie", [a.cookie]);
    expect(markRes.status).toBe(204);

    const countAfterMark = await request(app)
      .get("/api/notifications/unread-count")
      .set("Cookie", [a.cookie]);
    expect(countAfterMark.body.count).toBe(1);

    // Mark-all-read clears the rest.
    const readAllRes = await request(app)
      .post("/api/notifications/read-all")
      .set("Cookie", [a.cookie])
      .send({});
    expect(readAllRes.status).toBe(200);
    expect(readAllRes.body.updated).toBe(1);

    const countAfterAll = await request(app)
      .get("/api/notifications/unread-count")
      .set("Cookie", [a.cookie]);
    expect(countAfterAll.body.count).toBe(0);

    // Delete removes it from the list; B still can't delete A's remaining one.
    const deleteAsCrossUser = await request(app)
      .delete(`/api/notifications/${targetId}`)
      .set("Cookie", [b.cookie]);
    expect(deleteAsCrossUser.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/notifications/${targetId}`)
      .set("Cookie", [a.cookie]);
    expect(deleteRes.status).toBe(204);

    const finalList = await request(app)
      .get("/api/notifications")
      .set("Cookie", [a.cookie]);
    expect(finalList.body.data).toHaveLength(1);
  });

  it("preferences: defaults to inApp=true/email=false, respects updates, and notify() honors a disabled type", async () => {
    const { cookie, userId } = await signupAndLogin("notif-prefs@example.com");
    const orgId = await createOrg(cookie, "notif-prefs-org");

    const defaults = await request(app)
      .get("/api/notifications/preferences")
      .set("Cookie", [cookie]);
    expect(defaults.status).toBe(200);
    const mention = defaults.body.data.find(
      (p: { type: string }) => p.type === "MENTION",
    );
    expect(mention).toEqual({ type: "MENTION", inApp: true, email: false });

    // Disable in-app MENTION notifications.
    const update = await request(app)
      .put("/api/notifications/preferences")
      .set("Cookie", [cookie])
      .send([{ type: "MENTION", inApp: false, email: false }]);
    expect(update.status).toBe(200);

    // notify() should now silently skip writing a MENTION row for this user.
    await notify({
      recipientId: userId,
      organizationId: orgId,
      type: "MENTION",
      message: "should be suppressed",
    });

    const list = await request(app)
      .get("/api/notifications")
      .set("Cookie", [cookie]);
    expect(
      list.body.data.some((n: { message: string }) =>
        n.message.includes("should be suppressed"),
      ),
    ).toBe(false);

    // A different, still-enabled type still comes through.
    await notify({
      recipientId: userId,
      organizationId: orgId,
      type: "ASSIGNMENT",
      message: "should still arrive",
    });
    const list2 = await request(app)
      .get("/api/notifications")
      .set("Cookie", [cookie]);
    expect(
      list2.body.data.some((n: { message: string }) =>
        n.message.includes("should still arrive"),
      ),
    ).toBe(true);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
