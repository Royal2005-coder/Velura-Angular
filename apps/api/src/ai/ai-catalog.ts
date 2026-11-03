import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { selectOne, selectRows } from "../supabase.js";
import { HttpError } from "../http.js";
import { asString, asJsonObject, type JsonObject } from "../types.js";
import type { AiCatalog } from "./ai-service.js";
import type { CatalogImageVector } from "./image-vector-repository.js";
import sharp from "sharp";
import { fetchPublicCatalogImage } from "./public-image-fetch.js";
import { loadStudioAssets } from "./studio-assets.js";

/** Repository/network seams let QA verify SKU binding and SSRF guards without touching live products. */
export interface AiCatalogDependencies {
  product(id: string): Promise<JsonObject | null>;
  variant(productId: string, variantId: string): Promise<JsonObject | null>;
  fetchImage(url: URL, options: RequestInit): Promise<Response>;
}
/** Same revision binds discovery, fetched catalog bytes and stale-image exclusion. */
export function catalogImageRevision(product: JsonObject): string {
  return createHash("sha256").update(JSON.stringify([product.images, product.updated_at])).digest("hex");
}
const dependencies: AiCatalogDependencies = {
  product: (id) => selectOne("product", { product_id: `eq.${id}`, select: "*,category:category_id(slug)" }),
  variant: (productId, variantId) =>
    selectOne("variant", {
      variant_id: `eq.${variantId}`,
      product_id: `eq.${productId}`,
    }),
  fetchImage: fetchPublicCatalogImage,
};

const VTO_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  ao: ["upper_body"],
  "ao-khoac": ["upper_body"],
  quan: ["lower_body"],
  "dam-vay": ["lower_body", "dresses"],
};

/** Resolve only explicitly configured shop garment references and licensed studio assets. */
export class ShopAiCatalog implements AiCatalog {
  constructor(private readonly deps: AiCatalogDependencies = dependencies) {}
  /** Page only published catalog identifiers/revisions; no customer assets or admin writes. */
  async published(after: string, limit: number): Promise<Array<{ product_id: string; image_revision: string }>> {
    const { rows } = await selectRows("product", {
      select: "product_id,images,updated_at",
      status: "in.(on_sale,out_of_stock)",
      order: "product_id.asc",
      limit,
      ...(after ? { product_id: `gt.${after}` } : {}),
    }, { count: "none" });
    return rows.map(row => ({ product_id: asString(row.product_id), image_revision: catalogImageRevision(row) }));
  }
  /** Retain only published catalog products in visual recommendations. */
  async searchable(
    productId: string,
    imageRevision?: string,
  ): Promise<boolean> {
    const product = await this.deps.product(productId);
    return (
      !!product &&
      ["on_sale", "out_of_stock"].includes(asString(product.status)) &&
      (!imageRevision || imageRevision === catalogImageRevision(product))
    );
  }
  /** Require actual clothing; prefer operator-verified registry, fall back to catalog images for clothing. */
  async support(
    productId: string,
    variantId?: string,
  ): Promise<{ product_supported: boolean; variant_supported: boolean; garment_category?: string }> {
    const product = await this.deps.product(productId);
    if (!product || product.status !== "on_sale" || product.is_combo === true) {
      return { product_supported: false, variant_supported: false };
    }
    const catalogCategory = asString(asJsonObject(product?.category).slug);
    const allowedCategories = VTO_CATEGORIES[catalogCategory];
    if (!allowedCategories) {
      // Not clothing (e.g. phu-kien, giay-dep, set-do) → never offer VTO
      return { product_supported: false, variant_supported: false };
    }

    // 1. Check operator-verified registry first (highest priority)
    const registry = asJsonObject(JSON.parse(process.env.AI_VTO_PRODUCTS || "{}") as unknown);
    const garment = asJsonObject(registry[productId]);
    if (garment.verified === true && garment.photo_type === "flat-lay") {
      const category = asString(garment.category);
      if (allowedCategories.includes(category)) {
        return this.checkVariantsFromRegistry(productId, variantId, garment, category);
      }
    }

    // 2. Dynamic fallback: auto-infer category from catalog slug and use product images
    const inferredCategory = this.inferGarmentCategory(catalogCategory, product);
    if (!inferredCategory) return { product_supported: false, variant_supported: false };

    // Check if product has usable catalog images
    const images = Array.isArray(product.images) ? product.images : [];
    if (images.length === 0) return { product_supported: false, variant_supported: false };
    const primaryImageUrl = typeof images[0] === "string" ? images[0] : asString(asJsonObject(images[0]).url);
    try { this.allowedUrl(primaryImageUrl); } catch { return { product_supported: false, variant_supported: false }; }

    // Check variant existence
    let productSupported = true;
    let variantSupported = !variantId;
    if (variantId) {
      const variant = await this.deps.variant(productId, variantId);
      variantSupported = !!variant && variant.product_id === productId && variant.variant_id === variantId;
    }
    return {
      product_supported: productSupported,
      variant_supported: variantSupported,
      ...(productSupported ? { garment_category: inferredCategory } : {}),
    };
  }
  /** Check variant images from the verified registry. */
  private async checkVariantsFromRegistry(
    productId: string, variantId: string | undefined, garment: JsonObject, category: string,
  ): Promise<{ product_supported: boolean; variant_supported: boolean; garment_category?: string }> {
    let productSupported = false;
    let variantSupported = false;
    for (const [id, image] of Object.entries(asJsonObject(garment.variant_images))) {
      try { this.allowedUrl(asString(image)); } catch { continue; }
      const variant = await this.deps.variant(productId, id);
      if (!variant || variant.product_id !== productId || variant.variant_id !== id) continue;
      productSupported = true;
      if (id === variantId) variantSupported = true;
      if (!variantId || variantSupported) break;
    }
    return {
      product_supported: productSupported,
      variant_supported: variantSupported,
      ...(productSupported ? { garment_category: category } : {}),
    };
  }
  /** Infer AI worker garment category from database catalog slug and product name. */
  private inferGarmentCategory(catalogSlug: string, product: JsonObject): string | null {
    if (catalogSlug === "ao" || catalogSlug === "ao-khoac") return "upper_body";
    if (catalogSlug === "quan") return "lower_body";
    if (catalogSlug === "dam-vay") {
      // Skirts → lower_body, dresses → dresses
      const name = String(product.name || "").toLowerCase();
      const slug = String(product.slug || "").toLowerCase();
      if (/chân váy|chan.?vay|skirt/.test(name) || /chan.?vay|skirt/.test(slug)) return "lower_body";
      return "dresses";
    }
    return null;
  }
  /** Embed only the published shop's own catalog image and bounded style metadata. */
  async image(productId: string): Promise<{
    bytes: Buffer;
    metadata: Omit<CatalogImageVector, "embedding">;
  }> {
    const product = await this.deps.product(productId);
    if (
      !product ||
      !["on_sale", "out_of_stock"].includes(asString(product.status))
    )
      throw new HttpError(404, "PRODUCT_NOT_FOUND", "Sản phẩm không khả dụng.");
    const images = Array.isArray(product.images) ? product.images : [];
    // A broken primary CDN image must not exclude a SKU with another approved catalog photo.
    // Limit attempts and retain the whole image-set revision for stale-index invalidation.
    let bytes: Buffer | undefined;
    let lastError: unknown;
    for (const image of images.slice(0, 3)) {
      try {
        bytes = await this.fetchImage(
          typeof image === "string" ? image : asString(asJsonObject(image).url),
        );
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!bytes) {
      if (lastError instanceof HttpError) throw lastError;
      throw new HttpError(
        422,
        "CATALOG_IMAGE_UNAVAILABLE",
        "Sản phẩm chưa có ảnh hợp lệ để lập chỉ mục.",
      );
    }
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string").slice(0, 30)
        : [];
    return {
      bytes,
      metadata: {
        product_id: productId,
        model: "openclip-vit-b32-laion2b",
        image_revision: catalogImageRevision(product),
        category_id: asString(product.category_id),
        color_tone: asString(product.color_tone),
        style_tags: strings(product.style_tags),
        occasions: strings(product.occasions),
        suitable_body_shapes: strings(product.suitable_body_shapes),
      },
    };
  }
  /** Validate SKU ownership; prefer registry flat-lay, fall back to catalog primary image. */
  async garment(productId: string, variantId: string): Promise<{ bytes: Buffer; category: string }> {
    const support = await this.support(productId, variantId);
    if (!support.product_supported) throw new HttpError(422, "VTO_PRODUCT_UNAVAILABLE", "Sản phẩm chưa có ảnh flat-lay đã xác minh.");
    if (!support.variant_supported) throw new HttpError(422, "VTO_VARIANT_UNAVAILABLE", "Biến thể chưa có ảnh thử đồ đúng SKU.");
    // 1. Try operator-verified registry image
    const registry = asJsonObject(JSON.parse(process.env.AI_VTO_PRODUCTS || "{}") as unknown);
    const garment = asJsonObject(registry[productId]);
    const registryUrl = asString(asJsonObject(garment.variant_images)[variantId]);
    if (registryUrl) {
      try {
        return { bytes: await this.fetchImage(registryUrl), category: support.garment_category! };
      } catch { /* fall through to catalog image */ }
    }
    // 2. Fall back to product catalog primary image
    const product = await this.deps.product(productId);
    const images = Array.isArray(product?.images) ? product.images : [];
    for (const img of images.slice(0, 3)) {
      const url = typeof img === "string" ? img : asString(asJsonObject(img).url);
      try {
        return { bytes: await this.fetchImage(url), category: support.garment_category! };
      } catch { continue; }
    }
    throw new HttpError(422, "VTO_PRODUCT_UNAVAILABLE", "Sản phẩm chưa có ảnh phù hợp cho thử đồ.");
  }
  private async fetchImage(imageUrl: string): Promise<Buffer> {
    const url = this.allowedUrl(imageUrl);
    const response = await this.deps.fetchImage(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length") || 0) > 8 * 1024 * 1024
    )
      throw new HttpError(
        502,
        "GARMENT_IMAGE_UNAVAILABLE",
        "Không đọc được ảnh sản phẩm.",
      );
    if (!response.body)
      throw new HttpError(
        502,
        "GARMENT_IMAGE_UNAVAILABLE",
        "Không đọc được ảnh sản phẩm.",
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024)
        throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh sản phẩm quá lớn.");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    try {
      const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000, animated: false });
      const meta = await decoder.metadata();
      if (!["jpeg", "png", "webp"].includes(meta.format || "") || (meta.pages || 1) !== 1) throw new Error("IMAGE_FORMAT");
      const normalized = await decoder.rotate().png().toBuffer();
      if (normalized.length > 8 * 1024 * 1024)
        throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh sản phẩm sau chuẩn hóa vượt quá 8 MB.");
      return normalized;
    } catch (error) {
      if (error instanceof HttpError && error.code === "IMAGE_TOO_LARGE") throw error;
      throw new HttpError(422, "INVALID_GARMENT_IMAGE", "Ảnh sản phẩm không đọc được hoặc sai định dạng.");
    }
  }
  private allowedUrl(imageUrl: string): URL {
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      throw new HttpError(
        422,
        "INVALID_GARMENT_IMAGE",
        "Ảnh sản phẩm chưa được cấu hình.",
      );
    }
    const allowed = (process.env.AI_CATALOG_IMAGE_HOSTS || "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    const defaultAllowed = ["cdn.jsdelivr.net", "images.velura.vn", "images.unsplash.com", "res.cloudinary.com", "images.shop.test"];
    const isAllowedHost = allowed.length === 0
      ? true
      : allowed.includes(url.hostname.toLowerCase()) ||
        url.hostname.toLowerCase().endsWith(".supabase.co") ||
        defaultAllowed.includes(url.hostname.toLowerCase());

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port !== "" && url.port !== "443") ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      /(^localhost$|\.local$|\.internal$)/i.test(url.hostname) ||
      !isAllowedHost
    )
      throw new HttpError(
        422,
        "INVALID_GARMENT_IMAGE",
        "Ảnh sản phẩm chưa được cấu hình.",
      );
    return url;
  }
  /** Licensed studio images are server-local assets, never caller-provided filesystem paths. */
  async studio(id: string): Promise<Buffer> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id))
      throw new HttpError(422, "STUDIO_UNAVAILABLE", "Chọn mẫu studio hợp lệ.");
    const { root, registry: assets } = loadStudioAssets();
    const config = asJsonObject(assets[id]);
    const filename = asString(config.file);
    const path = resolve(root, filename);
    if (config.licensed !== true || !filename || !path.startsWith(root + sep))
      throw new HttpError(
        422,
        "STUDIO_UNAVAILABLE",
        "Ảnh studio chưa được cấp phép hoặc cấu hình.",
      );
    let bytes: Buffer;
    try {
      const actualRoot = await realpath(root),
        actualFile = await realpath(path);
      if (!actualFile.startsWith(actualRoot + sep))
        throw new HttpError(
          422,
          "STUDIO_UNAVAILABLE",
          "Ảnh studio không hợp lệ.",
        );
      if ((await stat(actualFile)).size > 8 * 1024 * 1024)
        throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh studio quá lớn.");
      bytes = await readFile(actualFile);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        422,
        "STUDIO_UNAVAILABLE",
        "Ảnh studio chưa khả dụng.",
      );
    }
    if (bytes.length > 8 * 1024 * 1024)
      throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh studio quá lớn.");
    return bytes;
  }
}
