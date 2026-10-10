import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../../scripts/run-migrations.mjs", import.meta.url));
const disconnected = {
  ...process.env,
  SUPABASE_DB_URL: "postgresql://never-connect:unused@127.0.0.1:1/postgres",
  SUPABASE_DB_CA_CERT: "not-a-real-certificate-file",
};

for (const scenario of [
  { name: "production stays read-only without owner opt-in", args: ["--environment=production", "054"], error: /Production is read-only by default/ },
  { name: "owner opt-in requires explicitly named production", args: ["--owner-approved-production", "054"], error: /require explicit --environment=production/ },
  { name: "staging cannot silently use the owner production opt-in", args: ["--environment=staging", "--owner-approved-production", "054"], error: /require explicit --environment=production/ },
  { name: "owner writes still require exact migration numbers", args: ["--environment=production", "--owner-approved-production"], error: /Supply explicit three-digit migration numbers/ },
  { name: "owner writes reject duplicate migration numbers", args: ["--environment=production", "--owner-approved-production", "054", "054"], error: /unique explicit three-digit numbers in ascending order/ },
  { name: "owner writes reject reversed prerequisite order", args: ["--environment=production", "--owner-approved-production", "056", "054"], error: /unique explicit three-digit numbers in ascending order/ },
]) {
  test(scenario.name, () => {
    const result = spawnSync(process.execPath, [runner, ...scenario.args], { encoding: "utf8", env: disconnected, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario.error);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONNREFUSED/, "approval/input checks must happen before credentials, CA files or database access");
  });
}

test("owner-approved production dry run inspects exact SQL without database or CA access", () => {
  const result = spawnSync(process.execPath, [runner, "--dry-run", "--environment=production", "--owner-approved-production", "054", "056", "057", "058"], { encoding: "utf8", env: disconnected, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /054_chatbot_governance\.sql/);
  assert.match(result.stdout, /056_chatbot_continuous_protection\.sql/);
  assert.match(result.stdout, /057_chatbot_support_promotions\.sql/);
  assert.match(result.stdout, /058_chatbot_reports\.sql/);
});
