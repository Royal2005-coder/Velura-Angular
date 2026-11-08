import type { VisualSearchRepository } from "../visual-search/visual-search-repository.js";
import type { SearchFilters, VisualCandidate, VisualSearchResult } from "../visual-search/visual-search-types.js";

/** Text-only semantic search, or photo + text-feedback composition (CLARTEMIS lineage). */
export type AiSearchMode = "text" | "composed";
/**
 * Same catalog contract as photo search plus the retrieval mode and the exact
 * normalized text the encoder received, so the UI can show what was understood.
 * Composed matches additionally carry `em_score`/`is_score` per candidate.
 */
export interface AiSearchResult extends VisualSearchResult {
  mode: AiSearchMode;
  query_text: string;
}
/** Retrieval boundary for composed search; photo-only retrieval stays on the visual contract. */
export interface AiSearchRepository extends VisualSearchRepository {
  /** Nearest catalog photos for normalize(reference+modifier), with EM/IS components attached. */
  composedSearch(reference: number[], modifier: number[], filters: SearchFilters): Promise<{ neighbors: VisualCandidate[]; featured: VisualCandidate[]; catalog_version: string }>;
}