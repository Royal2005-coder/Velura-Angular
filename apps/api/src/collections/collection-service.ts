import { HttpError } from "../http.js";
import type { Collection, CreateCollectionInput, UpdateCollectionInput } from "./collection-types.js";
import type { CollectionRepository } from "./collection-repository.js";

export interface CollectionService {
  listPublicCollections(): Promise<Collection[]>;
  listAdminCollections(): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection>;
  createCollection(input: CreateCollectionInput): Promise<Collection>;
  updateCollection(id: string, input: UpdateCollectionInput): Promise<Collection>;
  deleteCollection(id: string): Promise<{ success: boolean }>;
}

export function createCollectionService(deps: { repository: CollectionRepository }): CollectionService {
  const repo = deps.repository;

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
      if (!input.name || input.name.trim() === "") {
        throw new HttpError(400, "NAME_REQUIRED", "Tên bộ sưu tập là bắt buộc");
      }
      if (!input.code || input.code.trim() === "") {
        throw new HttpError(400, "CODE_REQUIRED", "Mã định danh bộ sưu tập là bắt buộc");
      }
      if (!input.story_desc || input.story_desc.trim() === "") {
        throw new HttpError(400, "STORY_DESC_REQUIRED", "Mô tả bộ sưu tập là bắt buộc");
      }

      const cleanCode = input.code.trim().toLowerCase().replace(/\s+/g, "-");
      const existing = await repo.getCollectionByCode(cleanCode);
      if (existing) {
        throw new HttpError(409, "CODE_ALREADY_EXISTS", `Mã bộ sưu tập '${cleanCode}' đã tồn tại`);
      }

      return repo.createCollection({
        ...input,
        name: input.name.trim(),
        code: cleanCode,
        label: input.label?.trim() || input.name.trim(),
        story_desc: input.story_desc.trim(),
      });
    },

    async updateCollection(id: string, input: UpdateCollectionInput) {
      let cleanCode: string | undefined = undefined;
      if (input.code) {
        cleanCode = input.code.trim().toLowerCase().replace(/\s+/g, "-");
        const existing = await repo.getCollectionByCode(cleanCode);
        if (existing && existing.collection_id !== id) {
          throw new HttpError(409, "CODE_ALREADY_EXISTS", `Mã bộ sưu tập '${cleanCode}' đã tồn tại`);
        }
      }

      const updated = await repo.updateCollection(id, {
        ...input,
        ...(cleanCode ? { code: cleanCode } : {}),
      });

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
