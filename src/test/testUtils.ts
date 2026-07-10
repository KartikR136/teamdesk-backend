export function extractCookie(setCookieHeader: string[], name: string): string {
  const match = setCookieHeader.find((c) => c.startsWith(`${name}=`));
  if (!match) throw new Error(`Cookie ${name} not found in response`);
  return match.split(";")[0]; // keeps only "name=value", drops Path/HttpOnly/etc.
}
