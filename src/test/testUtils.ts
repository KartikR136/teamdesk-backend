export function extractCookie(
  setCookieHeader: string | string[],
  name: string,
): string {
  const cookies = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : [setCookieHeader];

  const match = cookies.find((c) => c.startsWith(`${name}=`));

  if (!match) {
    throw new Error(`Cookie ${name} not found in response`);
  }

  return match.split(";")[0];
}
