import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";

/** Catalog image vector excludes private customer photos and Gemini's text vector namespace. */
export interface CatalogImageVector {
  product_id: string;
  model: "openclip-vit-b32-laion2b";
  embedding: number[];
  category_id?: string;
  style_tags?: string[];
  color_tone?: string;
  occasions?: string[];
  suitable_body_shapes?: string[];
  image_revision: string;
}
/** Apply the same explicit catalog/style dimensions when narrowing visual retrieval. */
export interface VisualSearchFilters {
  /** Restrict ranking to the existing catalog filter result before selecting the top visual matches. */
  product_ids?: string[];
  category_id?: string;
  style_tags?: string[];
  color_tone?: string;
  occasions?: string[];
  suitable_body_shapes?: string[];
}
/** Validate and normalize only the declared 512-dimensional CLIP namespace. */
export function normalizedImageVector(vector: unknown): number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== 512 ||
    vector.some((v) => typeof v !== "number" || !Number.isFinite(v))
  ) {
    throw new HttpError(
      422,
      "INVALID_IMAGE_VECTOR",
      "Vector hình ảnh không hợp lệ.",
    );
  }
  const norm = Math.sqrt(
    vector.reduce((sum: number, value: number) => sum + value * value, 0),
  );
  if (!Number.isFinite(norm) || norm < 1e-9)
    throw new HttpError(422, "INVALID_IMAGE_VECTOR", "Vector hình ảnh rỗng.");
  return vector.map((value: number) => value / norm);
}
/** Isolated local catalog index; never persist user search vectors or return random suggestions. */
export class LocalImageVectorRepository {
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  private async rows(): Promise<CatalogImageVector[]> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "catalog-image-vectors.json"), "utf8"),
      ) as CatalogImageVector[];
    } catch {
      return [];
    }
  }
  /** Read only SKU/image revisions so operator backfill can resume without recomputing fresh vectors. */
  async revisions(): Promise<Map<string, string>> {
    return new Map(
      (await this.rows()).map((row) => [row.product_id, row.image_revision]),
    );
  }
  /** Replace one SKU image revision after successful catalog-only embedding. */
  async upsert(row: CatalogImageVector): Promise<void> {
    await this.upsertBatch([row]);
  }
  /** Validate a whole worker batch first, then atomically replace SKU revisions in one local index commit. */
  async upsertBatch(batch: CatalogImageVector[]): Promise<void> {
    const normalized = batch.map((row) => ({
      ...row,
      embedding: normalizedImageVector(row.embedding),
    }));
    if (
      new Set(normalized.map((row) => row.product_id)).size !==
      normalized.length
    )
      throw new HttpError(
        422,
        "INVALID_IMAGE_VECTOR",
        "Chỉ mục chứa sản phẩm trùng.",
      );
    const pending = this.mutation.then(async () => {
      const ids = new Set(normalized.map((row) => row.product_id));
      const rows = (await this.rows()).filter(
        (row) => !ids.has(row.product_id),
      );
      rows.push(...normalized);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `${randomUUID()}.vector.tmp`);
      await writeFile(temporary, JSON.stringify(rows), { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(
            temporary,
            join(this.root, "catalog-image-vectors.json"),
          );
          break;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "";
          if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes(code))
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (attempt + 1)),
          );
        }
      }
    });
    this.mutation = pending.catch(() => undefined);
    await pending;
  }
  /** Rank actual compatible indexed products by cosine score, retaining catalog filters. */
  async search(
    vector: number[],
    filters: VisualSearchFilters = {},
  ): Promise<
    Array<{ product_id: string; score: number; image_revision: string }>
  > {
    const query = normalizedImageVector(vector);
    return (await this.rows())
      .filter(
        (row) =>
          row.model === "openclip-vit-b32-laion2b" &&
          (filters.product_ids === undefined ||
            filters.product_ids.includes(row.product_id)) &&
          (!filters.category_id || row.category_id === filters.category_id) &&
          (!filters.color_tone || row.color_tone === filters.color_tone) &&
          (["style_tags", "occasions", "suitable_body_shapes"] as const).every(
            (key) =>
              !filters[key]?.length ||
              filters[key]!.some((value) => row[key]?.includes(value)),
          ),
      )
      .map((row) => ({
        product_id: row.product_id,
        image_revision: row.image_revision,
        score: normalizedImageVector(row.embedding).reduce(
          (sum, value, i) => sum + value * query[i],
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
  }
}
