import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { selectOne } from "../supabase.js";
import { HttpError } from "../http.js";
import { asString, asJsonObject, type JsonObject } from "../types.js";
import type { AiCatalog } from "./ai-service.js";
import type { CatalogImageVector } from "./image-vector-repository.js";

/** Repository/network seams let QA verify SKU binding and SSRF guards without touching live products. */
export interface AiCatalogDependencies {
  product(id: string): Promise<JsonObject | null>;
  variant(productId: string, variantId: string): Promise<JsonObject | null>;
  fetchImage(url: URL, options: RequestInit): Promise<Response>;
}
const dependencies: AiCatalogDependencies = {
  product: (id) => selectOne("product", { product_id: `eq.${id}` }),
  variant: (productId, variantId) =>
    selectOne("variant", {
      variant_id: `eq.${variantId}`,
      product_id: `eq.${productId}`,
    }),
  fetchImage: (url, options) => fetch(url, options),
};

/** Resolve only explicitly configured shop garment references and licensed studio assets. */
export class ShopAiCatalog implements AiCatalog {
  constructor(private readonly deps: AiCatalogDependencies = dependencies) {}
  /** Retain only published catalog products in visual recommendations. */
  async searchable(
    productId: string,
    imageRevision?: string,
  ): Promise<boolean> {
    const product = await this.deps.product(productId);
    return (
      !!product &&
      ["on_sale", "out_of_stock"].includes(asString(product.status)) &&
      (!imageRevision || imageRevision === this.revision(product))
    );
  }
  private revision(product: JsonObject): string {
    return createHash("sha256")
      .update(JSON.stringify([product.images, product.updated_at]))
      .digest("hex");
  }
  /** Validate published SKU and configured variant garment references without downloading photos. */
  async support(
    productId: string,
    variantId?: string,
  ): Promise<{
    product_supported: boolean;
    variant_supported: boolean;
    garment_category?: string;
  }> {
    const product = await this.deps.product(productId);
    const registry = asJsonObject(
        JSON.parse(process.env.AI_VTO_PRODUCTS || "{}") as unknown,
      ),
      garment = asJsonObject(registry[productId]);
    const category = asString(garment.category);
    if (
      !product ||
      !["on_sale", "out_of_stock"].includes(asString(product.status)) ||
      !["upper_body", "lower_body", "dresses"].includes(category)
    )
      return { product_supported: false, variant_supported: false };
    if (!variantId || !(await this.deps.variant(productId, variantId)))
      return {
        product_supported: true,
        variant_supported: false,
        garment_category: category,
      };
    const imageUrl =
      asString(asJsonObject(garment.variant_images)[variantId]) ||
      (garment.variant_id === variantId ? asString(garment.image_url) : "");
    try {
      this.allowedUrl(imageUrl);
      return {
        product_supported: true,
        variant_supported: true,
        garment_category: category,
      };
    } catch {
      return {
        product_supported: true,
        variant_supported: false,
        garment_category: category,
      };
    }
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
        image_revision: this.revision(product),
        category_id: asString(product.category_id),
        color_tone: asString(product.color_tone),
        style_tags: strings(product.style_tags),
        occasions: strings(product.occasions),
        suitable_body_shapes: strings(product.suitable_body_shapes),
      },
    };
  }
  /** Validate SKU ownership and supported category against operator-controlled VTO config. */
  async garment(
    productId: string,
    variantId: string,
  ): Promise<{ bytes: Buffer; category: string }> {
    const product = await this.deps.product(productId);
    const variant = await this.deps.variant(productId, variantId);
    const registry = asJsonObject(
      JSON.parse(process.env.AI_VTO_PRODUCTS || "{}") as unknown,
    );
    const garment = asJsonObject(registry[productId]);
    if (
      !product ||
      !["on_sale", "out_of_stock"].includes(asString(product.status)) ||
      !variant ||
      !["upper_body", "lower_body", "dresses"].includes(
        asString(garment.category),
      )
    ) {
      throw new HttpError(
        422,
        "VTO_PRODUCT_UNAVAILABLE",
        "Sản phẩm này chưa có ảnh thử đồ phù hợp.",
      );
    }
    const variantImages = asJsonObject(garment.variant_images);
    const imageUrl =
      asString(variantImages[variantId]) ||
      (garment.variant_id === variantId ? asString(garment.image_url) : "");
    if (!imageUrl)
      throw new HttpError(
        422,
        "VTO_VARIANT_UNAVAILABLE",
        "Biến thể này chưa có ảnh thử đồ phù hợp.",
      );
    return {
      bytes: await this.fetchImage(imageUrl),
      category: asString(garment.category),
    };
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
    return Buffer.concat(chunks);
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
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      /(^localhost$|\.local$|\.internal$)/i.test(url.hostname) ||
      !allowed.includes(url.hostname)
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
    const assets = asJsonObject(
      JSON.parse(process.env.AI_STUDIO_ASSETS || "{}") as unknown,
    );
    const config = asJsonObject(assets[id]);
    const root = resolve(
      process.env.AI_STUDIO_ASSET_ROOT || "scratch/ai-studio",
    );
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
