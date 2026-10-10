import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { selectRows } from "../supabase.js";
import { asString } from "../types.js";
import { AiService } from "./ai-service.js";
import { LocalAiRepository } from "./ai-repository.js";
import { ShopAiCatalog } from "./ai-catalog.js";
import { ColabAiWorker } from "./colab-worker.js";
import { HttpError } from "../http.js";
import { LocalImageVectorRepository } from "./image-vector-repository.js";

/** Operator-only bounded catalog backfill uses the same consent, queue and CLIP namespace as admin jobs.
 * Run with the API stopped to preserve the local single-process GPU claim:
 * node --env-file-if-exists=.env --import tsx apps/api/src/ai/index-catalog.ts --limit 10
 * It never reads user-uploaded photos or modifies transactional catalog data.
 */
async function main(): Promise<void> {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AI_INDEX_OPERATOR_CONFIRMED !== "true"
  )
    throw new Error("LOCAL_OPERATOR_CONFIRMATION_REQUIRED");
  const position = process.argv.indexOf("--limit"),
    limit = position >= 0 ? Number(process.argv[position + 1]) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("INVALID_INDEX_LIMIT");
  const batchPosition = process.argv.indexOf("--batch-size"),
    batchSize =
      batchPosition >= 0 ? Number(process.argv[batchPosition + 1]) : 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16)
    throw new Error("INVALID_BATCH_SIZE");
  const service = new AiService(
    new LocalAiRepository(
      resolve(process.env.AI_PRIVATE_ROOT || "scratch/ai-private"),
    ),
    new ColabAiWorker(),
    new ShopAiCatalog(),
  );
  if (
    !service
      .capabilities()
      .tasks.some((task) => task.task === "image_embedding" && task.enabled)
  )
    throw new Error("IMAGE_EMBEDDING_NOT_VERIFIED");
  const { rows: published } = await selectRows(
    "product",
    {
      select: "product_id,images,updated_at",
      status: "in.(on_sale,out_of_stock)",
      order: "product_id.asc",
      limit,
    },
    { count: "none" },
  );
  const existing = process.argv.includes("--missing-only")
    ? await new LocalImageVectorRepository(
        resolve(process.env.AI_PRIVATE_ROOT || "scratch/ai-private"),
      ).revisions()
    : new Map<string, string>();
  const rows = published.filter(
    (row) =>
      existing.get(asString(row.product_id)) !==
      createHash("sha256")
        .update(JSON.stringify([row.images, row.updated_at]))
        .digest("hex"),
  );
  const owner = "operator:local-catalog-index",
    run = randomUUID();
  let success = 0,
    failed = 0;
  try {
    await service.recover();
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const ids = rows
        .slice(offset, offset + batchSize)
        .map((row) => asString(row.product_id));
      const productId = ids[0];
      try {
        const job = await service.create(
          owner,
          {
            task: "image_embedding",
            catalog_index: true,
            ...(batchSize === 1
              ? { product_id: productId }
              : { catalog_product_ids: ids }),
            consent: true,
            confirmed: true,
            idempotency_key: `index-${run}-${productId}`,
          },
          true,
        );
        let current = job;
        const deadline = Date.now() + 21 * 60_000;
        while (
          ["queued", "running"].includes(current.status) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          current = await service.get(owner, job.id);
        }
        if (current.status === "success") {
          success += current.index_summary?.indexed ?? 1;
          failed += current.index_summary?.failed ?? 0;
          for (const error of current.index_summary?.errors || [])
            console.error(
              `Catalog image skipped: ${error.product_id} (${error.error})`,
            );
        } else {
          failed += ids.length;
          console.error(
            `Catalog indexing failed: ${productId} (${current.error || current.status})`,
          );
        }
      } catch (error) {
        failed += ids.length;
        console.error(
          `Catalog indexing unavailable: ${productId} (${error instanceof HttpError ? error.code : "AI_INDEX_FAILED"})`,
        );
      }
      if (!service.capabilities().enabled) break;
      console.log(
        JSON.stringify({
          processed: Math.min(offset + batchSize, rows.length),
          indexed: success,
          failed,
          total: rows.length,
        }),
      );
    }
    console.log(
      JSON.stringify({
        indexed: success,
        failed,
        total: rows.length,
        namespace: "openclip-vit-b32-laion2b",
        dimensions: 512,
      }),
    );
    if (failed) process.exitCode = 1;
  } finally {
    await service.close();
  }
}
void main().catch(() => {
  console.error(
    "Local catalog indexing failed; inspect private runtime configuration.",
  );
  process.exitCode = 1;
});
