const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
  testMatch: ["**/*.test.ts"],
  // 30s, not 10s: this suite makes real, sequential, unmocked round trips
  // to Postgres per TESTING.md's own design. Against a serverless DB
  // (Neon) that can cold-start/scale-to-zero when idle, a handful of
  // consecutive awaited queries in one test can occasionally exceed 10s
  // even though every query eventually succeeds — this isn't slack for a
  // broken test, it's headroom for the database's worst-case latency.
  testTimeout: 30000,
};
