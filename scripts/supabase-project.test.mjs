import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { databaseProjectRef, requireProductionProjectRef, requireStagingProjectRef } from "./supabase-project.mjs";

const production = "a".repeat(20);
const staging = "b".repeat(20);
const password = "never-print-this-password";
const direct = ref => `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres`;
const pooled = ref => `postgres://postgres.${ref}:${password}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;

test("direct and pooler identities resolve to the same actual project", () => {
  assert.equal(databaseProjectRef(direct(staging)), staging);
  assert.equal(databaseProjectRef(pooled(staging)), staging);
  assert.equal(databaseProjectRef(pooled(staging).replace(`postgres.${staging}`, `postgres%2E${staging}`)), staging);
  assert.equal(requireStagingProjectRef(direct(staging), production), staging);
  assert.equal(requireStagingProjectRef(pooled(staging), production), staging);
});

test("trusted production identity is mandatory and cannot be a URL or malformed reference", () => {
  for (const value of [undefined, "", "invalid", "A".repeat(20), direct(production)]) {
    assert.throws(() => requireProductionProjectRef(value), /trusted PRODUCTION_SUPABASE_PROJECT_REF/);
    assert.throws(() => requireStagingProjectRef(direct(staging), value), /trusted PRODUCTION_SUPABASE_PROJECT_REF/);
  }
});

test("equal projects fail across direct and shared pooler forms regardless of database path", () => {
  for (const url of [direct(production), pooled(production), pooled(production).replace(/6543\/postgres$/, "6543/different_database")]) {
    assert.throws(() => requireStagingProjectRef(url, production), /matches production/);
  }
});

test("unknown or contradictory host and username identities fail without disclosing credentials", () => {
  for (const url of ["not-a-url", direct(staging).replace("postgresql:", "https:"),
    direct(staging).replace(".supabase.co", ".supabase.co.evil.invalid"),
    pooled(staging).replace(`postgres.${staging}`, "postgres"),
    pooled(staging).replace(".pooler.supabase.com", ".pooler.supabase.com.evil.invalid"),
    direct(staging).replace("//postgres:", `//postgres.${production}:`),
    pooled(staging).replace(`postgres.${staging}`, "postgres%ZZ")]) {
    assert.throws(() => databaseProjectRef(url), error => {
      assert.equal(error.message, "Unrecognized Supabase database identity.");
      assert.ok(!error.message.includes(password));
      return true;
    });
  }
});

test("migration check and writes reject unsafe stage identity before reading CA or connecting", () => {
  const runner = fileURLToPath(new URL("./run-migrations.mjs", import.meta.url));
  const cases = [
    { url: direct(staging), trusted: "", expected: /trusted PRODUCTION_SUPABASE_PROJECT_REF/ },
    { url: direct(production), trusted: production, expected: /matches production/ },
    { url: pooled(production), trusted: production, expected: /matches production/ },
    { url: direct(staging).replace(".supabase.co", ".invalid"), trusted: production, expected: /Unrecognized Supabase database identity/ }
  ];
  for (const args of [["--check"], ["060", "061"]]) {
    for (const { url, trusted, expected } of cases) {
      const result = spawnSync(process.execPath, [runner, "--environment=staging", ...args], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, STAGING_SUPABASE_DB_URL: url, PRODUCTION_SUPABASE_PROJECT_REF: trusted,
          STAGING_SUPABASE_DB_CA_CERT: fileURLToPath(new URL("./nonexistent-isolation-test-ca.pem", import.meta.url)) }
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(password));
      assert.doesNotMatch(result.stderr, /ENOENT|certificate verification is required|ENOTFOUND/);
    }
  }
});
