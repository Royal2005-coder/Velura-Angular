import { buildDashboardSummary } from "./apps/api/src/dashboard.js";

async function test() {
  try {
    const summary = await buildDashboardSummary(null);
    console.log("=== API Summary Output ===");
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error("Error building summary:", err);
  }
  process.exit(0);
}

test();
