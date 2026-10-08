import { callRpc } from "../supabase.js";
import type { JsonObject } from "../types.js";
import type { CatalogContentRepository } from "./catalog-content-types.js";

/** Only the API service role can execute operations; PostgreSQL rechecks the active product-admin actor. */
export function createCatalogContentRepository(): CatalogContentRepository {
  return {
    async execute<T>(actor: string | null, action: string, payload: JsonObject = {}): Promise<T> {
      return await callRpc("catalog_content_operation", { p_actor: actor, p_action: action, p_payload: payload }, { useAnonKey: false, silentError: true }) as T;
    }
  };
}
