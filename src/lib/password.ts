import bcrypt from "bcrypt";

const SALT_ROUNDS = 12; // industry-standard range is 10-12; higher = slower = more resistant to brute force

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
