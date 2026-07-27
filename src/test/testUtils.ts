export function extractCookie(
  setCookieHeader: string | string[] | undefined,
  name: string,
): string {
  if (!setCookieHeader) {
    throw new Error(
      `extractCookie: no Set-Cookie header in response. ` +
        `The request likely failed before cookies were issued — ` +
        `check that the endpoint returned a success status and that ` +
        `all pending Prisma migrations have been applied (npx prisma db push).`,
    );
  }

  const cookies = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : [setCookieHeader];

  const match = cookies.find((c) => c != null && c.startsWith(`${name}=`));

  if (!match) {
    throw new Error(
      `Cookie "${name}" not found in Set-Cookie header. ` +
        `Present cookies: [${cookies.map((c) => c?.split("=")[0] ?? "(null)").join(", ")}]`,
    );
  }

  return match.split(";")[0];
}
