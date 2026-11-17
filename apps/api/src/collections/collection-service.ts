import { HttpError } from "../http.js";
import {
  assertLinkUrl,
  assertMaxLength,
  assertMediaUrl,
  assertSortOrder,
} from "../content/cms-validation.js";
import type { Collection, CollectionHeroMode, CreateCollectionInput, UpdateCollectionInput } from "./collection-types.js";
import type { CollectionRepository } from "./collection-repository.js";

/** Số người mẫu cố định của hero `/collections` và của runway trang chủ. */
const MODEL_SLOTS = 5;
/** Số combo/set tối đa của một bộ sưu tập. */
const MAX_PRODUCT_IDS = 10;
const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GRADIENT_PATTERN = /^linear-gradient\([^;{}]{1,300}\)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trường chuỗi tùy chọn và giới hạn độ dài (FR-4, §5.3). */
const TEXT_LIMITS = [
  ["label", 80, "Nhãn"],
  ["kicker", 60, "Kicker"],
  ["story_headline", 120, "Tiêu đề câu chuyện"],
  ["explore_cta", 40, "Nút khám phá"],
  ["products_sub", 40, "Phụ đề cụm sản phẩm"],
  ["products_title", 80, "Tiêu đề cụm sản phẩm"],
  ["closing_quote", 200, "Câu trích kết"],
  ["script", 40, "Chữ viết tay"],
  ["col_number", 60, "Số bộ sưu tập"],
  ["badge", 30, "Huy hiệu"],
] as const;

/** Trạng thái dùng cho các luật chéo (bản ghép: bản ghi hiện có + patch). */
interface CrossState {
  banner_url: string | null | undefined;
  hero_mode: CollectionHeroMode;
  models: string[];
  is_active: boolean;
  show_on_home: boolean;
  home_model_url: string | null | undefined;
}

export interface CollectionService {
  listPublicCollections(): Promise<Collection[]>;
  listAdminCollections(): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection>;
  createCollection(input: CreateCollectionInput): Promise<Collection>;
  updateCollection(id: string, input: UpdateCollectionInput): Promise<Collection>;
  deleteCollection(id: string): Promise<{ success: boolean }>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "FIELD_INVALID", `${label} không hợp lệ`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "FIELD_INVALID", `${label} không hợp lệ`);
  }
  return value;
}

/** Chuỗi rỗng → null; còn lại kiểm URL media (FR-S3). */
function normalizeMediaUrl(value: unknown, label: string): string | null {
  if (value === null) return null;
  const text = requireString(value, label);
  if (text === "") return null;
  assertMediaUrl(text, label);
  return text;
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_MEDIA_URL", "Danh sách ảnh người mẫu không hợp lệ");
  }
  if (value.length > MODEL_SLOTS) {
    throw new HttpError(400, "MODELS_TOO_MANY", `Tối đa ${MODEL_SLOTS} ảnh người mẫu`);
  }
  return value.map((item, index) => {
    const text = requireString(item, `Ảnh người mẫu ${index + 1}`);
    assertMediaUrl(text, `Ảnh người mẫu ${index + 1}`);
    return text;
  });
}

function normalizeProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "PRODUCT_IDS_INVALID", "Danh sách combo/set không hợp lệ");
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item.trim())) {
      throw new HttpError(400, "PRODUCT_IDS_INVALID", "Mã sản phẩm combo/set không hợp lệ");
    }
    const id = item.trim().toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length > MAX_PRODUCT_IDS) {
    throw new HttpError(400, "PRODUCT_IDS_INVALID", `Tối đa ${MAX_PRODUCT_IDS} combo/set cho mỗi bộ sưu tập`);
  }
  return ids;
}

/** Kiểm từng trường có mặt trong patch (không kiểm trường vắng mặt để không chặn dữ liệu cũ). */
function normalizePatch(input: UpdateCollectionInput): UpdateCollectionInput {
  const out: UpdateCollectionInput = { ...input };

  if (input.name !== undefined) {
    const name = requireString(input.name, "Tên bộ sưu tập");
    if (name === "") throw new HttpError(400, "NAME_REQUIRED", "Tên bộ sưu tập là bắt buộc");
    assertMaxLength(name, 80, "Tên bộ sưu tập");
    out.name = name;
  }
  if (input.story_desc !== undefined) {
    const desc = requireString(input.story_desc, "Mô tả bộ sưu tập");
    if (desc === "") throw new HttpError(400, "STORY_DESC_REQUIRED", "Mô tả bộ sưu tập là bắt buộc");
    assertMaxLength(desc, 600, "Mô tả bộ sưu tập");
    out.story_desc = desc;
  }
  if (input.home_story !== undefined) {
    if (input.home_story === null) {
      out.home_story = null;
    } else {
      const story = requireString(input.home_story, "Mô tả ngắn");
      assertMaxLength(story, 160, "Mô tả ngắn");
      out.home_story = story === "" ? null : story;
    }
  }
  for (const [field, max, label] of TEXT_LIMITS) {
    const value = input[field];
    if (value === undefined) continue;
    const text = requireString(value, label);
    assertMaxLength(text, max, label);
    out[field] = text;
  }
  if (input.category_link !== undefined) {
    const link = requireString(input.category_link, "Liên kết bộ sưu tập");
    assertLinkUrl(link, "Liên kết bộ sưu tập", 255);
    out.category_link = link;
  }
  if (input.hero_gradient !== undefined) {
    const gradient = requireString(input.hero_gradient, "Màu nền hero");
    if (!GRADIENT_PATTERN.test(gradient)) {
      throw new HttpError(400, "INVALID_GRADIENT", "Màu nền hero phải có dạng linear-gradient(...)");
    }
    out.hero_gradient = gradient;
  }
  if (input.banner_url !== undefined) out.banner_url = normalizeMediaUrl(input.banner_url, "Ảnh bìa");
  if (input.home_model_url !== undefined) out.home_model_url = normalizeMediaUrl(input.home_model_url, "Ảnh người mẫu trang chủ");
  if (input.models !== undefined) out.models = normalizeModels(input.models);
  if (input.hero_mode !== undefined && input.hero_mode !== "models" && input.hero_mode !== "cover") {
    throw new HttpError(400, "INVALID_HERO_MODE", "Chế độ hero phải là 'models' hoặc 'cover'");
  }
  if (input.is_active !== undefined) out.is_active = requireBoolean(input.is_active, "Trạng thái hoạt động");
  if (input.show_on_home !== undefined) out.show_on_home = requireBoolean(input.show_on_home, "Hiển thị trang chủ");
  if (input.sort_order !== undefined) out.sort_order = assertSortOrder(input.sort_order, "Thứ tự");
  if (input.home_sort_order !== undefined) out.home_sort_order = assertSortOrder(input.home_sort_order, "Thứ tự trang chủ");
  if (input.product_ids !== undefined) out.product_ids = normalizeProductIds(input.product_ids);
  return out;
}

export function createCollectionService(deps: { repository: CollectionRepository }): CollectionService {
  const repo = deps.repository;

  /** Mỗi id phải tồn tại và là combo (E4): không lọc im lặng. */
  async function assertComboProducts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await repo.findComboProductIds(ids);
    for (const id of ids) {
      const isCombo = found.get(id);
      if (isCombo === undefined) {
        throw new HttpError(400, "PRODUCT_NOT_FOUND", `Không tìm thấy sản phẩm ${id}`);
      }
      if (!isCombo) {
        throw new HttpError(400, "PRODUCT_NOT_COMBO", `Sản phẩm ${id} không phải combo/set`);
      }
    }
  }

  /** Luật chéo trên bản ghép (bản ghi + patch). `selfId` loại chính nó khỏi đếm slot trang chủ. */
  async function assertCrossRules(state: CrossState, selfId?: string): Promise<void> {
    if (state.hero_mode === "cover" && !state.banner_url) {
      throw new HttpError(400, "COVER_REQUIRED", "Chế độ ảnh bìa cần tải lên ảnh bìa");
    }
    if (state.is_active && state.hero_mode === "models" && state.models.length !== MODEL_SLOTS) {
      throw new HttpError(
        400,
        "MODELS_REQUIRED",
        `Bộ sưu tập đang bật ở chế độ 5 người mẫu cần đủ ${MODEL_SLOTS} ảnh (hiện có ${state.models.length})`
      );
    }
    if (state.show_on_home) {
      if (!state.home_model_url) {
        throw new HttpError(400, "HOME_MODEL_REQUIRED", "Hiển thị trang chủ cần có ảnh người mẫu trang chủ");
      }
      if (state.is_active) {
        const others = (await repo.listCollections()).filter(
          (c) => c.collection_id !== selfId && c.is_active && c.show_on_home
        );
        if (others.length >= MODEL_SLOTS) {
          throw new HttpError(
            409,
            "HOME_SLOTS_FULL",
            `Trang chủ chỉ hiển thị tối đa ${MODEL_SLOTS} người mẫu; hãy tắt một bộ sưu tập khác trước`
          );
        }
      }
    }
  }

  return {
    async listPublicCollections() {
      return repo.listCollections({ is_active: true });
    },

    async listAdminCollections() {
      return repo.listCollections();
    },

    async getCollection(id: string) {
      const collection = await repo.getCollectionById(id);
      if (!collection) {
        throw new HttpError(404, "COLLECTION_NOT_FOUND", "Không tìm thấy bộ sưu tập");
      }
      return collection;
    },

    async createCollection(input: CreateCollectionInput) {
      if (typeof input.name !== "string" || input.name.trim() === "") {
        throw new HttpError(400, "NAME_REQUIRED", "Tên bộ sưu tập là bắt buộc");
      }
      if (typeof input.code !== "string" || input.code.trim() === "") {
        throw new HttpError(400, "CODE_REQUIRED", "Mã định danh bộ sưu tập là bắt buộc");
      }
      if (typeof input.story_desc !== "string" || input.story_desc.trim() === "") {
        throw new HttpError(400, "STORY_DESC_REQUIRED", "Mô tả bộ sưu tập là bắt buộc");
      }

      const cleanCode = input.code.trim().toLowerCase().replace(/\s+/g, "-");
      if (cleanCode.length > 60 || !CODE_PATTERN.test(cleanCode)) {
        throw new HttpError(
          400,
          "CODE_INVALID",
          "Mã bộ sưu tập chỉ gồm chữ thường, số và dấu gạch ngang, tối đa 60 ký tự"
        );
      }

      // Rỗng = dùng giá trị mặc định của repository (khớp hành vi trước đây).
      const raw: CreateCollectionInput = { ...input };
      if (raw.category_link === "") delete raw.category_link;
      if (raw.hero_gradient === "") delete raw.hero_gradient;

      const patch = normalizePatch({ ...raw, code: undefined });
      const name = patch.name as string;
      const label = patch.label || name;

      const existing = await repo.getCollectionByCode(cleanCode);
      if (existing) {
        throw new HttpError(409, "CODE_ALREADY_EXISTS", `Mã bộ sưu tập '${cleanCode}' đã tồn tại`);
      }

      if (patch.product_ids) await assertComboProducts(patch.product_ids);
      await assertCrossRules({
        banner_url: patch.banner_url,
        hero_mode: patch.hero_mode ?? "models",
        models: patch.models ?? [],
        is_active: patch.is_active ?? true,
        show_on_home: patch.show_on_home ?? false,
        home_model_url: patch.home_model_url,
      });

      return repo.createCollection({
        ...patch,
        code: cleanCode,
        name,
        label,
        story_desc: patch.story_desc as string,
      });
    },

    async updateCollection(id: string, input: UpdateCollectionInput) {
      const existing = await repo.getCollectionById(id);
      if (!existing) {
        throw new HttpError(404, "COLLECTION_NOT_FOUND", "Không tìm thấy bộ sưu tập cần cập nhật");
      }

      if (input.code !== undefined) {
        const cleanCode = typeof input.code === "string" ? input.code.trim().toLowerCase().replace(/\s+/g, "-") : "";
        if (cleanCode !== existing.code) {
          throw new HttpError(400, "CODE_IMMUTABLE", "Không thể đổi mã bộ sưu tập sau khi tạo; hãy sửa tên bộ sưu tập");
        }
      }

      const { code: _ignoredCode, ...rest } = input;
      const patch = normalizePatch(rest);
      if (patch.label !== undefined && patch.label === "") {
        patch.label = patch.name ?? existing.name;
      }

      if (patch.product_ids) await assertComboProducts(patch.product_ids);

      const merged = { ...existing, ...patch };
      await assertCrossRules(
        {
          banner_url: merged.banner_url,
          hero_mode: merged.hero_mode ?? "models",
          models: Array.isArray(merged.models) ? merged.models : [],
          is_active: merged.is_active,
          show_on_home: merged.show_on_home === true,
          home_model_url: merged.home_model_url,
        },
        id
      );

      const updated = await repo.updateCollection(id, patch);
      if (!updated) {
        throw new HttpError(404, "COLLECTION_NOT_FOUND", "Không tìm thấy bộ sưu tập cần cập nhật");
      }
      return updated;
    },

    async deleteCollection(id: string) {
      await repo.deleteCollection(id);
      return { success: true };
    },
  };
}
