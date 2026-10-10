import type { JsonObject } from "../types.js";

/** Immutable verified input; commercial fields deliberately never enter the model prompt. */
export interface CatalogSource {
  productId: string;
  version: number;
  revision: string;
  fields: Record<string, string>;
  photos: string[];
}
/** A factual statement is composed exclusively of quoted catalog fragments, with field evidence. */
export interface GroundedClaim {
  text: string;
  sources: { field: string; quote: string }[];
}
/** Reviewed content does not contain writable identity, price, stock, SKU or variant identifiers. */
export interface CatalogContent {
  title: GroundedClaim;
  short: GroundedClaim;
  long: GroundedClaim;
  highlights: GroundedClaim[];
  styling: GroundedClaim[];
  care: GroundedClaim[];
  seoTitle: GroundedClaim;
  metaDescription: GroundedClaim;
  proposedSlug: string;
  primaryKeywords: GroundedClaim[];
  secondaryKeywords: GroundedClaim[];
  alt: { photo: string; claim: GroundedClaim }[];
  tags: GroundedClaim[];
}
/** Model and source provenance survive all edits and publication; generated content is immutable. */
export interface CatalogDraft {
  id: string;
  product_id: string;
  source: CatalogSource;
  generated: CatalogContent;
  reviewed: CatalogContent | null;
  status: "draft" | "approved" | "rejected" | "published";
  version: number;
  metadata: { model: string; schema: string; prompt: string; sourceRevision: string };
  created_at: string;
}
/** Durable per-product queue outcomes expose finite errors without changing published content. */
export interface CatalogBatch {
  id: string;
  status: "queued" | "running" | "complete";
  items: { id: string; product_id: string; status: "queued" | "running" | "success" | "failed"; draft_id: string | null; error: string | null }[];
  completed: number;
  total: number;
}
/** Database operations remain in the repository; worker claims use an internal service-role RPC. */
export interface CatalogContentRepository {
  execute<T>(actor: string | null, action: string, payload?: JsonObject): Promise<T>;
}
/** A lease token binds a worker completion to one durable immutable source snapshot. */
export interface CatalogWork {
  id: string;
  actor_id: string;
  lease: string;
  source: CatalogSource;
}
