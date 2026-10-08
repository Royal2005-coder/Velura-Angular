/** Image inference tasks run in a private worker, independently of Gemini text embeddings. */
export type AiTask =
  | "image_quality"
  | "image_embedding"
  | "virtual_try_on"
  | "product_image_enhance";
/** Terminal inference statuses never imply an unavailable model produced an image. */
export type AiStatus =
  | "queued"
  | "running"
  | "success"
  | "validation_failed"
  | "failed"
  | "cancelled";
/** Private uploaded asset; its path is never exposed through the API. */
export interface AiAsset {
  id: string;
  owner: string;
  path: string;
  expires_at: string;
  mime: string;
}
/** Public job projection excludes owner, input paths and biometric images. */
export interface AiJobView {
  id: string;
  task: AiTask;
  status: AiStatus;
  created_at: string;
  expires_at: string;
  result_url?: string;
  gate?: Record<string, unknown>;
  error?: string;
  matches?: Array<{ product_id: string; score: number }>;
  index_summary?: {
    indexed: number;
    failed: number;
    errors: Array<{ product_id: string; error: string }>;
  };
}
/** Stored local job binds idempotency and every input to one principal. */
export interface AiJob extends AiJobView {
  owner: string;
  idempotency_key: string;
  fingerprint: string;
  directory: string;
  worker: Record<string, unknown>;
  product_id?: string;
  variant_id?: string;
  processing_version?: string;
  catalog_metadata?: Omit<
    import("./image-vector-repository.js").CatalogImageVector,
    "embedding"
  >;
  catalog_batch_metadata?: Array<{
    image: string;
    metadata: Omit<
      import("./image-vector-repository.js").CatalogImageVector,
      "embedding"
    >;
  }>;
}
/** Worker output is validated before it can become a public job result. */
export interface AiWorkerResult {
  status: "success" | "validation_failed" | "failed";
  gate?: Record<string, unknown>;
  result_file?: string;
  embedding?: number[];
  model?: string;
  dimensions?: number;
  processing_version?: string;
  binding?: { request_id: string; product_id: string; variant_id: string };
  batch_embeddings?: Array<{
    image: string;
    embedding?: number[];
    error_code?: string;
  }>;
}
/** Adapter is isolated so tests exercise ownership and queue rules without consuming GPU. */
export interface AiWorker {
  ready(task?: AiTask): boolean;
  /** Refresh authenticated backend health before advertising or enqueuing a capability. */
  refreshReadiness?(): Promise<void>;
  run(directory: string, signal: AbortSignal): Promise<AiWorkerResult>;
}
