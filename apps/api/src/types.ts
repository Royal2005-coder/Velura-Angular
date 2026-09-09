import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/**
 * JSON object from an HTTP body or PostgREST row.
 */
export type JsonObject = Record<string, unknown>;

/**
 * CORS / extra response headers produced by the HTTP helpers.
 */
export type HeaderMap = Record<string, string>;

/**
 * Minimal request surface used by routers and tests (not a full IncomingMessage).
 */
export interface HttpRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string };
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<unknown>;
}

/**
 * Minimal response surface used by routers and tests.
 */
export interface HttpResponse {
  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): unknown;
  end(chunk?: string | Buffer): unknown;
  setHeader(name: string, value: number | string | readonly string[]): unknown;
  hasHeader?(name: string): boolean;
}

/**
 * Authenticated or guest principal attached to an API request.
 */
export interface AuthUser {
  id: string;
  email?: string | null;
}

/**
 * Row from `users` used by RBAC. Extra PostgREST columns are allowed.
 */
export interface UserProfile {
  user_id: string;
  auth_user_id?: string | null;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
  role?: string | null;
  admin_role?: string | null;
  is_active?: boolean | null;
  is_verified?: boolean | null;
  version?: number | null;
  [key: string]: unknown;
}

/**
 * Auth + RBAC context passed from the server into routers and services.
 */
export interface AuthContext {
  authUser: AuthUser | null;
  profile: UserProfile | null;
  roleCode: string;
  roleName: string;
  isAdmin: boolean;
  allowedPages: string[];
  accessToken: string;
}

/**
 * Client metadata captured for audit logs.
 */
export interface RequestMeta {
  ipAddress: string;
}

/**
 * Result of a fixed-window rate-limit consume.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Rate limiter used by mutation and chat routes.
 */
export interface RateLimiter {
  consume(key: string, now?: number): RateLimitResult;
}

/**
 * Duck-typed service object. Routers call named methods; tests stub subsets.
 */
export type RouteService = object;

/**
 * Arguments shared by versioned `/api/v1` routers.
 */
export interface RouteArgs<TService = RouteService> {
  req: HttpRequest;
  res: HttpResponse;
  url: URL;
  parts: string[];
  headers: HeaderMap;
  context?: AuthContext;
  service: TService;
  limiter?: RateLimiter;
}

/**
 * Narrow unknown JSON into an object. Arrays and primitives become `{}`.
 */
export function asJsonObject(value: unknown): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

/**
 * True when value is a non-null object (not an array).
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Message string from an unknown thrown value.
 */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
