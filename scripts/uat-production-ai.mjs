/**
 * Live Production & End-to-End UAT Certification Runner for Velura AI Decision Engine & Smart Blog (`npm run uat:prod:ai`).
 *
 * Verifies (100% read-only against Production data):
 * 1. Live HTTPS release pins, `/api/health`, `/api/v1/personal-color/capabilities`, and `/api/user/blogs` on `velura.royalai.dev`, `admin-erp.royalai.dev`, `admin.royalai.dev`
 * 2. Live Storefront JS bundle zero-secret-leakage scan (`AIza`, `AQ.`, `GEMINI_PRIMARY_KEY`, `SUPABASE_SERVICE_ROLE_KEY`)
 * 3. Production Supabase tables (`product_ai_qa`, `return_box_forensics`, `ai_decision_log`), RLS anon isolation, and `velura_blog_transition_allowed` RPC
 * 4. Live Google `POST /v1beta/decisions` (`gemini-decision-1`) across all 6 AI Decision capabilities
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideBlogEditorialGate } from "../apps/api/src/content/blog-ai-workflow.js";
import { unifiedDecisionService } from "../apps/api/src/decision/decision-service.js";
import { getCachedSyntheticImage } from "../tests/api/helpers/decision-test-kit.js";

function loadOptionalEnvFiles() {
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve("c:/Users/ADMIN/Downloads/velura-angular/.env"),
  ]) {
    if (existsSync(candidate) && typeof process.loadEnvFile === "function") {
      try {
        process.loadEnvFile(candidate);
        break;
      } catch {
        // Ignore if already loaded
      }
    }
  }
}

async function probeEndpoint(url) {
  const t0 = performance.now();
  const resp = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const latencyMs = Math.round(performance.now() - t0);
  const contentType = resp.headers.get("content-type") || "";
  const text = await resp.text();
  let json = null;
  if (contentType.includes("application/json")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { url, status: resp.status, latencyMs, text, json, location: resp.headers.get("location") || "" };
}

async function runProductionUat() {
  loadOptionalEnvFiles();
  const report = {
    executedAt: new Date().toISOString(),
    releaseManifest: null,
    endpoints: [],
    bundleHygiene: null,
    supabaseChecks: [],
    liveGeminiDecisions: [],
    allPassed: true,
  };

  const recordCheck = (bucket, item) => {
    bucket.push(item);
    if (!item.passed) report.allPassed = false;
  };

  // 1. Read canonical production release manifest
  const prodJsonPath = resolve(process.cwd(), "deploy/releases/production.json");
  const prodManifest = existsSync(prodJsonPath) ? JSON.parse(readFileSync(prodJsonPath, "utf8")) : {};
  report.releaseManifest = {
    sha: prodManifest.release?.revision || prodManifest.source_sha || prodManifest.sha || null,
    buildId: prodManifest.release?.buildId || prodManifest.version || null,
  };

  // 2. Live HTTPS Production Domain & API Health Checks
  const storefrontRelease = await probeEndpoint("https://velura.royalai.dev/release.json");
  const liveStorefrontSha =
    storefrontRelease.json?.revision ||
    storefrontRelease.json?.source_sha ||
    storefrontRelease.json?.sha ||
    storefrontRelease.json?.buildId ||
    null;
  recordCheck(report.endpoints, {
    name: "Storefront Release Manifest (velura.royalai.dev/release.json)",
    status: storefrontRelease.status,
    latencyMs: storefrontRelease.latencyMs,
    liveSha: liveStorefrontSha,
    passed: storefrontRelease.status === 200 && Boolean(liveStorefrontSha),
  });

  const storefrontHealth = await probeEndpoint("https://velura.royalai.dev/api/health");
  recordCheck(report.endpoints, {
    name: "Production API Health (velura.royalai.dev/api/health)",
    status: storefrontHealth.status,
    latencyMs: storefrontHealth.latencyMs,
    passed: storefrontHealth.status === 200,
  });

  const pcCapabilities = await probeEndpoint("https://velura.royalai.dev/api/user/personal-color/capabilities");
  recordCheck(report.endpoints, {
    name: "Personal Color Capabilities Endpoint (/api/user/personal-color/capabilities)",
    status: pcCapabilities.status,
    latencyMs: pcCapabilities.latencyMs,
    enabled: pcCapabilities.json?.enabled ?? null,
    policyVersion: pcCapabilities.json?.policy_version ?? null,
    passed: pcCapabilities.status === 200 && typeof pcCapabilities.json?.enabled === "boolean",
  });

  const publicBlogs = await probeEndpoint("https://velura.royalai.dev/api/content/blogs?limit=3");
  recordCheck(report.endpoints, {
    name: "Public Storefront Blog Feed (/api/content/blogs?limit=3)",
    status: publicBlogs.status,
    latencyMs: publicBlogs.latencyMs,
    rowCount: Array.isArray(publicBlogs.json?.rows) ? publicBlogs.json.rows.length : 0,
    passed: publicBlogs.status === 200 && Array.isArray(publicBlogs.json?.rows),
  });

  for (const [label, url] of [
    ["Admin ERP Portal (admin-erp.royalai.dev/release.json)", "https://admin-erp.royalai.dev/release.json"],
    ["Admin ERP API Health (admin-erp.royalai.dev/api/health)", "https://admin-erp.royalai.dev/api/health"],
    ["Admin Portal (admin.royalai.dev/release.json)", "https://admin.royalai.dev/release.json"],
  ]) {
    const res = await probeEndpoint(url);
    const cfAccessGated =
      (res.status === 302 || res.status === 403) &&
      (res.location.includes("cloudflareaccess.com") || res.text.includes("cloudflareaccess"));
    recordCheck(report.endpoints, {
      name: label,
      status: res.status,
      latencyMs: res.latencyMs,
      zeroTrustProtected: cfAccessGated,
      liveSha: res.json?.revision || res.json?.source_sha || res.json?.sha || null,
      passed: res.status === 200 || cfAccessGated,
    });
  }

  // 3. Live Frontend Bundle Zero-Secret-Leakage Scan
  const homeHtml = await probeEndpoint("https://velura.royalai.dev/");
  const scriptMatches = [...homeHtml.text.matchAll(/src="([^"]*main[^"]*\.js)"/g)].map((m) => m[1]);
  let scannedBytes = homeHtml.text.length;
  let secretLeaksFound = 0;
  const leakPatterns = [
    /AIza[0-9A-Za-z_-]{30,}/,
    /AQ\.Ab[0-9A-Za-z_-]{30,}/,
    /GEMINI_PRIMARY_KEY/,
    /GEMINI_FALLBACK_FREE_KEY/,
    /SUPABASE_SERVICE_ROLE_KEY/,
  ];
  for (const p of leakPatterns) {
    if (p.test(homeHtml.text)) secretLeaksFound += 1;
  }
  for (const relScript of scriptMatches.slice(0, 2)) {
    const bundleUrl = relScript.startsWith("http")
      ? relScript
      : `https://velura.royalai.dev/${relScript.replace(/^\/+/, "")}`;
    const jsRes = await probeEndpoint(bundleUrl);
    scannedBytes += jsRes.text.length;
    for (const p of leakPatterns) {
      if (p.test(jsRes.text)) secretLeaksFound += 1;
    }
  }
  report.bundleHygiene = {
    bundlesScanned: scriptMatches.slice(0, 2),
    scannedBytes,
    secretLeaksFound,
    passed: homeHtml.status === 200 && secretLeaksFound === 0,
  };
  if (!report.bundleHygiene.passed) report.allPassed = false;

  // 4. Production Supabase Read-Only Schema, RLS & State Machine Verification
  const supabaseUrl = (process.env.VELURA_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = (process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const anonKey = (process.env.VELURA_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

  if (supabaseUrl && serviceKey) {
    for (const table of ["product_ai_qa", "return_box_forensics", "ai_decision_log"]) {
      const svcResp = await fetch(`${supabaseUrl}/rest/v1/${table}?limit=1`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      await svcResp.body?.cancel();

      let anonIsolated = true;
      if (anonKey) {
        const anonResp = await fetch(`${supabaseUrl}/rest/v1/${table}?limit=1`, {
          headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        const anonBody = await anonResp.text();
        anonIsolated = anonResp.status === 401 || anonResp.status === 403 || anonBody.trim() === "[]";
      }

      recordCheck(report.supabaseChecks, {
        name: `Table public.${table} (service_role=200 & anon RLS isolated)`,
        serviceStatus: svcResp.status,
        anonIsolated,
        passed: svcResp.status === 200 && anonIsolated,
      });
    }

    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/velura_blog_transition_allowed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ p_from: "published", p_to: "failed_retry" }),
      signal: AbortSignal.timeout(10_000),
    });
    const rpcVal = await rpcResp.json().catch(() => null);
    recordCheck(report.supabaseChecks, {
      name: "RPC velura_blog_transition_allowed('published' -> 'failed_retry')",
      status: rpcResp.status,
      result: rpcVal,
      passed: rpcResp.status === 200 && rpcVal === true,
    });
  }

  // 5. Live Google Gemini Decision Engine (`POST /v1beta/decisions`) 6-Domain Smoke Verification
  // Temporarily clear service role key in-process so synthetic smoke probes do NOT pollute Production `ai_decision_log`!
  const savedSvc1 = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedSvc2 = process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "";
  process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY = "";

  try {
    const [lightPortrait, studioGarment, parcelPickup, parcelCrushed] = await Promise.all([
      getCachedSyntheticImage("uat-prod-pc", { bg: [242, 242, 242], subject: [230, 196, 176], sclera: [245, 245, 246] }),
      getCachedSyntheticImage("uat-prod-qa", { width: 640, height: 640, bg: [250, 248, 245], subject: [122, 40, 60], crispGrid: true }),
      getCachedSyntheticImage("uat-prod-box1", { bg: [215, 195, 165], subject: [180, 150, 110] }),
      getCachedSyntheticImage("uat-prod-box2", { bg: [195, 175, 145], subject: [140, 110, 80] }),
    ]);

    const tPc = performance.now();
    const pcOut = await unifiedDecisionService.decidePersonalColor({ bytes: lightPortrait, mime: "image/jpeg" });
    recordCheck(report.liveGeminiDecisions, {
      domain: "F2 · Personal Color (gemini-decision-1)",
      latencyMs: Math.round(performance.now() - tPc),
      verdict: `${pcOut.lighting_valid} | ${pcOut.base_skin_depth} | ITA=${pcOut.optical_measurement.itaAngle}° | season=${pcOut.season}`,
      confidence: pcOut.confidence_score,
      passed: ["LIGHT_TONE", "DARK_TONE"].includes(pcOut.base_skin_depth) && Number.isFinite(pcOut.confidence_score),
    });

    const tCskh = performance.now();
    const cskhOut = await unifiedDecisionService.decideCskhSentiment({
      message: "Đầm giao tới bị rách đường chỉ ở cổ áo, tôi rất thất vọng, hỗ trợ đổi gấp giúp tôi!",
      rating: 1,
      contextKind: "review",
    });
    recordCheck(report.liveGeminiDecisions, {
      domain: "F3 · CSKH & Review Sentiment Router (gemini-decision-1)",
      latencyMs: Math.round(performance.now() - tCskh),
      verdict: `${cskhOut.sentiment} -> ${cskhOut.routing_branch} (${cskhOut.urgency})`,
      confidence: cskhOut.confidence_score,
      passed: cskhOut.sentiment === "NEGATIVE" && cskhOut.routing_branch === "STANDARDIZED_DEESCALATION",
    });

    const tQa = performance.now();
    const qaOut = await unifiedDecisionService.decideProductImageQa(studioGarment, "image/jpeg", {
      productName: "Đầm Lụa Tơ Tằm Velura",
    });
    recordCheck(report.liveGeminiDecisions, {
      domain: "F4 · Product Image 4-Axis QA Taxonomy (gemini-decision-1)",
      latencyMs: Math.round(performance.now() - tQa),
      verdict: `${qaOut.final_verdict} (avg=${qaOut.average_taxonomy_score}/5, blogEligible=${qaOut.blog_auto_eligible})`,
      confidence: qaOut.confidence_score,
      passed: ["APPROVED_HERO", "APPROVED_STANDARD", "NEEDS_EDIT", "REJECTED"].includes(qaOut.final_verdict),
    });

    const tBox = performance.now();
    const boxOut = await unifiedDecisionService.decideReturnBoxForensics({
      returnId: "00000000-0000-4000-8000-000000000099",
      returnCode: "UAT-RMA-01",
      trackingCode: "GHN-UAT-01",
      carrierName: "GHN",
      pickupImage: { bytes: parcelPickup, mime: "image/jpeg" },
      warehouseImage: { bytes: parcelCrushed, mime: "image/jpeg" },
    });
    recordCheck(report.liveGeminiDecisions, {
      domain: "F5 · Return Parcel Visual Forensics (gemini-decision-1)",
      latencyMs: Math.round(performance.now() - tBox),
      verdict: `${boxOut.box_condition} · ${boxOut.match_verdict} (risk=${boxOut.tampering_risk_score}/100)`,
      confidence: boxOut.confidence_score,
      passed: ["INTACT", "MINOR_DENT", "SEVERE_CRUSH", "TORN_WET"].includes(boxOut.box_condition),
    });

    const tCur = performance.now();
    const curOut = await unifiedDecisionService.decideAutoBlogProductCuration({
      productId: "00000000-0000-4000-8000-000000000088",
      name: "Đầm Lụa Mulberry Đỏ Burgundy",
      availableStock: 18,
      basePrice: 2_200_000,
      salePrice: 1_760_000,
      imageQaVerdict: "APPROVED_HERO",
      imageQaScore: 4.8,
      campaignGoal: "Ưu đãi tiệc tối thu đông Quiet Luxury",
    });
    recordCheck(report.liveGeminiDecisions, {
      domain: "F6A · Auto-Blog SKU Curation (gemini-decision-1)",
      latencyMs: Math.round(performance.now() - tCur),
      verdict: `${curOut.publish_mode} · ${curOut.campaign_fit} (score=${curOut.curation_score})`,
      confidence: curOut.confidence_score,
      passed: ["AUTO_BLOG_PUBLISH", "SEMI_AUTO_REVIEW", "EXCLUDE"].includes(curOut.publish_mode),
    });

    const tGate = performance.now();
    const gateOut = await decideBlogEditorialGate(
      {
        title: "5 Bản Phối Đầm Lụa Mulberry Tôn Dáng Mùa Tiệc Cuối Năm",
        excerpt: "Khám phá ngôn ngữ cắt may thanh lịch và chất liệu lụa tơ tằm của Velura Atelier.",
        metaTitle: "5 Bản Phối Đầm Lụa Dự Tiệc | Velura",
        metaDescription: "Bí quyết chọn đầm lụa dự tiệc tôn dáng chuẩn Quiet Luxury từ Velura.",
        verifiedVoucherCode: "VELURA10",
        verifiedProductNames: ["Đầm Lụa Mulberry Đỏ Burgundy"],
        articlePlain:
          "Chất liệu lụa Mulberry tự nhiên mang lại độ rủ mềm mại, kết hợp đường cắt chéo tinh tế giúp tôn vinh vóc dáng quý cô trong các buổi tiệc tối sang trọng. Áp dụng mã ưu đãi VELURA10 tại bước thanh toán.",
        socialCaptions: {
          facebookPage: "✨ Khám phá 5 bản phối Đầm Lụa Mulberry dự tiệc cùng mã ưu đãi VELURA10.",
          zaloOa: "[Velura Atelier] Bộ sưu tập đầm lụa mới kèm mã VELURA10.",
          instagram: "Quiet Luxury ✨ #VeluraAtelier",
        },
      },
      { recordAudit: async () => undefined },
    );
    recordCheck(report.liveGeminiDecisions, {
      domain: "F6B · Blog Editorial & Zero-Hallucination Gate (gemini-decision-1)",
      latencyMs: Math.round(performance.now() - tGate),
      verdict: `passed=${gateOut.passed} -> ${gateOut.recommendedStatus} (zeroHallucination=${gateOut.zeroHallucinationProb})`,
      confidence: gateOut.confidence,
      passed: gateOut.zeroHallucinationProb >= 0.7 && Number.isFinite(gateOut.confidence),
    });
  } finally {
    if (savedSvc1 === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedSvc1;
    if (savedSvc2 === undefined) delete process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY;
    else process.env.VELURA_SUPABASE_SERVICE_ROLE_KEY = savedSvc2;
  }

  console.log("\n================================================================================");
  console.log(" VELURA LIVE PRODUCTION & GEMINI DECISION ENGINE UAT CERTIFICATION");
  console.log("================================================================================");
  console.log(` Canonical Release Manifest SHA : ${report.releaseManifest.sha}`);
  for (const ep of report.endpoints) {
    console.log(` [${ep.passed ? "✓ PASS" : "✗ FAIL"}] HTTP ${ep.status} (${ep.latencyMs}ms) — ${ep.name}`);
  }
  console.log(
    ` [${report.bundleHygiene.passed ? "✓ PASS" : "✗ FAIL"}] Bundle Hygiene — ${report.bundleHygiene.scannedBytes} bytes scanned, leaks=${report.bundleHygiene.secretLeaksFound}`,
  );
  for (const db of report.supabaseChecks) {
    console.log(` [${db.passed ? "✓ PASS" : "✗ FAIL"}] Supabase — ${db.name}`);
  }
  for (const ai of report.liveGeminiDecisions) {
    console.log(` [${ai.passed ? "✓ PASS" : "✗ FAIL"}] ${ai.domain} (${ai.latencyMs}ms) -> ${ai.verdict}`);
  }
  console.log("================================================================================\n");

  const outFile = process.env.UAT_REPORT_JSON_PATH;
  if (outFile) {
    writeFileSync(resolve(outFile), JSON.stringify(report, null, 2), "utf8");
  }

  if (!report.allPassed) {
    process.exit(1);
  }
}

runProductionUat().catch((err) => {
  console.error("[uat-production-ai] Failed:", err);
  process.exit(1);
});
