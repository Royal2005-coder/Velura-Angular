/**
 * Zero-Disk-Mutation Node ESM Loader Hook for AI Decision & Blog Mutation Testing.
 *
 * Activated via:
 *   VELURA_MUTANT_ID=M1 node --import tsx --import ./scripts/mutant-loader.mjs --test <spec>
 *
 * Intercepts ONLY the targeted TypeScript module in RAM, injects the exact semantic fault,
 * transpiles via TypeScript in-memory, and NEVER modifies any file on disk.
 */

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const AI_MUTATION_CATALOG = {
  M1: {
    id: "M1",
    domain: "F1 · Decision Gateway",
    description: "Disable secondary Free-Tier / gemini.env failover when Primary Key returns 429/503",
    fileSuffix: "apps/api/src/decision/gemini-decision-client.ts",
    target: "if (fallbackKey && fallbackKey !== primaryKey) {",
    replacement: "if (false && fallbackKey && fallbackKey !== primaryKey) {",
    spec: "tests/api/uat-f1-decision-gateway.test.ts",
  },
  M2: {
    id: "M2",
    domain: "F2 · Personal Color ITA°",
    description: "Corrupt CIE L*a*b* ITA° LIGHT_TONE/DARK_TONE boundary from 28° to 95°",
    fileSuffix: "apps/api/src/decision/decision-service.ts",
    target: 'const measuredBaseDepth: BaseSkinDepth = itaAngle >= 28 ? "LIGHT_TONE" : "DARK_TONE";',
    replacement: 'const measuredBaseDepth: BaseSkinDepth = itaAngle >= 95 ? "LIGHT_TONE" : "DARK_TONE";',
    spec: "tests/api/uat-f2-personal-color.test.ts",
  },
  M3: {
    id: "M3",
    domain: "F3 · CSKH 1-2★ Safety Anchor",
    description: "Disable unconditional NEGATIVE clamp on sarcastic 1-2 star customer reviews",
    fileSuffix: "apps/api/src/decision/decision-service.ts",
    target: 'if (typeof input.rating === "number" && input.rating >= 1 && input.rating <= 2) {',
    replacement: 'if (typeof input.rating === "number" && input.rating >= 1 && input.rating <= 0) {',
    spec: "tests/api/uat-f3-cskh-and-reviews.test.ts",
  },
  M4: {
    id: "M4",
    domain: "F3 · Chatbot L3 Escalation",
    description: "Suppress corroborated L3 human handoff when Decision Engine flags escalate_to_human",
    fileSuffix: "apps/api/src/chatbot/llm-service.ts",
    target: "if (sentimentDecision.escalate_to_human && corroboratesHumanEscalation(analysis)) {",
    replacement: "if (false && sentimentDecision.escalate_to_human && corroboratesHumanEscalation(analysis)) {",
    spec: "tests/api/uat-f3-cskh-and-reviews.test.ts",
  },
  M5: {
    id: "M5",
    domain: "F4 · Image QA Physical Cap",
    description: "Disable physical Sharp telemetry & single-axis <= 2.0 REJECTED guardrail",
    fileSuffix: "apps/api/src/decision/decision-service.ts",
    target: "if (physicalCap < 5.0 || minAxis <= 2.0 || (cutoffAns.noul >= 0.80 && compositionFraming <= 2.5)) {",
    replacement: "if (false && (physicalCap < 5.0 || minAxis <= 2.0)) {",
    spec: "tests/api/uat-f4-product-image-qa.test.ts",
  },
  M6: {
    id: "M6",
    domain: "F5 · Return Forensics Freeze",
    description: "Bypass server-side 409 RETURN_REFUND_FROZEN_BY_FORENSICS guard on Stripe/Manual refunds",
    fileSuffix: "apps/api/src/returns/return-service.ts",
    target: "if (latestForensics?.freeze_auto_refund === true) {",
    replacement: "if (false && latestForensics?.freeze_auto_refund === true) {",
    spec: "tests/api/uat-f5-return-forensics.test.ts",
  },
  M7: {
    id: "M7",
    domain: "F6 · Blog Zero-SKU-Hallucination",
    description: "Allow out-of-stock (available_stock <= 0) & REJECTED QA items into AI Blog campaigns",
    fileSuffix: "apps/api/src/content/blog-ai-workflow.ts",
    target: 'if (item.available_stock <= 0 || item.image_qa_verdict === "REJECTED") return false;',
    replacement: 'if (false && (item.available_stock <= 0 || item.image_qa_verdict === "REJECTED")) return false;',
    spec: "tests/api/uat-f6-blog-curation-workflow.test.ts",
  },
  M8: {
    id: "M8",
    domain: "F7 · Newsletter XSS Hygiene",
    description: "Disable HTML XSS escaping in automated scheduled blog broadcast emails",
    fileSuffix: "apps/api/src/newsletter/newsletter-service.ts",
    target: "const safeTitle = escapeEmailHtml(title);",
    replacement: "const safeTitle = title;",
    spec: "tests/api/uat-f7-blog-scheduler-and-prod.test.ts",
  },
  M9: {
    id: "M9",
    domain: "F1 · Decision Admin RBAC Gate",
    description: "Bypass module-level products.update RBAC check on /api/v1/admin/ai-decisions/product-qa",
    fileSuffix: "apps/api/src/decision/decision-router.ts",
    target: 'requirePermission(context as AuthContext, "products", "update");',
    replacement: "/* RBAC_MUTANT_BYPASSED */",
    spec: "tests/api/uat-f1-decision-gateway.test.ts",
  },
  M10: {
    id: "M10",
    domain: "F6 · Batch SKU Curation Ceiling",
    description: "Allow non-HERO product images to bypass human review into AUTO_BLOG_PUBLISH in batch curation",
    fileSuffix: "apps/api/src/decision/decision-service.ts",
    target: 'if (publishMode === "AUTO_BLOG_PUBLISH" && item.imageQaVerdict !== "APPROVED_HERO") {',
    replacement: 'if (false && publishMode === "AUTO_BLOG_PUBLISH" && item.imageQaVerdict !== "APPROVED_HERO") {',
    spec: "tests/api/uat-f6-blog-curation-workflow.test.ts",
  },
};

export async function load(url, context, nextLoad) {
  const mutantId = process.env.VELURA_MUTANT_ID || "";
  const mutant = AI_MUTATION_CATALOG[mutantId];
  if (!mutant || !url.startsWith("file://")) {
    return nextLoad(url, context);
  }

  const normalizedPath = fileURLToPath(url).replace(/\\/g, "/");
  if (!normalizedPath.endsWith(mutant.fileSuffix)) {
    return nextLoad(url, context);
  }

  const originalTs = readFileSync(fileURLToPath(url), "utf8");
  if (!originalTs.includes(mutant.target)) {
    throw new Error(`[mutant-loader] Target snippet not found for ${mutantId} in ${mutant.fileSuffix}`);
  }
  const mutatedTs = originalTs.replace(mutant.target, mutant.replacement);
  const transpiled = ts.transpileModule(mutatedTs, {
    fileName: normalizedPath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      isolatedModules: true,
    },
  });

  return {
    format: "module",
    shortCircuit: true,
    source: transpiled.outputText,
  };
}

// Self-register when imported via `--import ./scripts/mutant-loader.mjs` in a child test runner
if (process.env.VELURA_MUTANT_ID && process.env.VELURA_MUTANT_HOOK_REGISTERED !== "1") {
  process.env.VELURA_MUTANT_HOOK_REGISTERED = "1";
  register(pathToFileURL(fileURLToPath(import.meta.url)).href);
}
