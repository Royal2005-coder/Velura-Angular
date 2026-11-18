/**
 * In-Memory AI Decision & Blog Mutation Testing Runner (`npm run test:mutate:ai`).
 *
 * Executes all 8 semantic mutants (`M1`–`M8`) across `F1`–`F7` in isolated worker processes:
 * - Zero disk writes (asserts `git status --porcelain` is unchanged before & after).
 * - Zero live external API quota consumption (scrubs external keys in child env).
 * - Requires 100% Mutation Kill Score (`8/8 KILLED`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { AI_MUTATION_CATALOG } from "./mutant-loader.mjs";

function readGitStatusSnapshot() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

export function runAiMutationSuite() {
  const beforeGit = readGitStatusSnapshot();
  const mutants = Object.values(AI_MUTATION_CATALOG);
  const rows = [];
  const startedAt = performance.now();

  for (const mutant of mutants) {
    const t0 = performance.now();
    const childEnv = {
      ...process.env,
      VELURA_MUTANT_ID: mutant.id,
      VELURA_MUTANT_HOOK_REGISTERED: "",
      GEMINI_PRIMARY_KEY: "",
      GEMINI_API_KEY: "",
      GEMINI_FALLBACK_FREE_KEY: "",
      GEMINI_DECISION_FALLBACK_KEY: "",
      ALLOW_LOCAL_GEMINI_ENV_FALLBACK: "false",
      LITELLM_ENDPOINT: "",
      LITELLM_API_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", "./scripts/mutant-loader.mjs", "--test", mutant.spec],
      {
        cwd: process.cwd(),
        env: childEnv,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    const elapsedMs = Math.round(performance.now() - t0);
    const combinedOutput = `${res.stdout || ""}\n${res.stderr || ""}`;
    const loaderCrashed = combinedOutput.includes("[mutant-loader] Target snippet not found");
    const killed = !loaderCrashed && res.status !== 0;

    rows.push({
      id: mutant.id,
      domain: mutant.domain,
      description: mutant.description,
      spec: mutant.spec,
      killed,
      loaderCrashed,
      exitCode: res.status,
      elapsedMs,
    });
  }

  const afterGit = readGitStatusSnapshot();
  const worktreeCleanlyPreserved = beforeGit === afterGit;
  const killedCount = rows.filter((r) => r.killed).length;
  const totalCount = rows.length;
  const killScorePct = Number(((killedCount / totalCount) * 100).toFixed(1));
  const totalElapsedMs = Math.round(performance.now() - startedAt);

  console.log("\n================================================================================");
  console.log(" VELURA AI DECISION & BLOG — IN-MEMORY MUTATION TESTING MATRIX (M1–M8)");
  console.log("================================================================================");
  for (const r of rows) {
    const badge = r.killed ? "✓ KILLED  " : r.loaderCrashed ? "✗ INVALID " : "✗ SURVIVED";
    console.log(` [${r.id}] ${badge} | ${r.domain.padEnd(28)} | ${String(r.elapsedMs).padStart(4)}ms | ${r.spec}`);
  }
  console.log("--------------------------------------------------------------------------------");
  console.log(
    ` Mutation Kill Score: ${killedCount}/${totalCount} (${killScorePct}%) | Worktree Untouched: ${worktreeCleanlyPreserved} | Total: ${totalElapsedMs}ms`,
  );
  console.log("================================================================================\n");

  if (!worktreeCleanlyPreserved) {
    console.error("[mutate-ai-suite] FATAL: Git worktree status changed during mutation run!");
    process.exit(1);
  }
  if (killedCount !== totalCount) {
    const survivors = rows.filter((r) => !r.killed);
    console.error("[mutate-ai-suite] Surviving or invalid mutants detected:", JSON.stringify(survivors, null, 2));
    process.exit(1);
  }

  return { killedCount, totalCount, killScorePct, worktreeCleanlyPreserved, totalElapsedMs, rows };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("mutate-ai-suite.mjs")) {
  runAiMutationSuite();
}
