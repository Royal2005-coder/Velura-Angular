export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}
