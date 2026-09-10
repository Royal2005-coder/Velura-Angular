import { HttpError } from "../http.js";
import type { ContentRepository } from "./content-repository.js";

/**
 * Public content use-cases consumed by `handleContentRoute`.
 */
export interface ContentService {
  listCategories(searchParams: URLSearchParams): ReturnType<ContentRepository["listCategories"]>;
  listBlogs(searchParams: URLSearchParams): ReturnType<ContentRepository["listBlogs"]>;
  getBlog(slug: string): Promise<Awaited<ReturnType<ContentRepository["getBlog"]>>>;
  listPolicies(): ReturnType<ContentRepository["listPolicies"]>;
  getPolicy(slug: string): Promise<Awaited<ReturnType<ContentRepository["getPolicy"]>>>;
  getStaticPage(slug: string): Promise<Awaited<ReturnType<ContentRepository["getStaticPage"]>>>;
}

/**
 * Build the public content service around a PostgREST repository.
 */
export function createContentService({ repository }: { repository: ContentRepository }): ContentService {
  if (!repository) throw new TypeError("repository is required");

  return {
    listCategories(searchParams) {
      const type = searchParams.get("type") || "";
      if (type && !["blog", "policy", "page"].includes(type)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid content category type");
      }
      return repository.listCategories(type || undefined);
    },

    listBlogs(searchParams) {
      const categorySlug = sanitizeSlug(searchParams.get("category") || "");
      return repository.listBlogs({
        categorySlug: categorySlug || undefined,
        featuredFirst: searchParams.get("featuredFirst") !== "false",
        limit: boundedInteger(searchParams.get("limit"), 20, 1, 100),
        offset: boundedInteger(searchParams.get("offset"), 0, 0, 100000)
      });
    },

    async getBlog(slug) {
      const blog = await repository.getBlog(requireSlug(slug));
      if (!blog) throw new HttpError(404, "BLOG_NOT_FOUND", "Blog post not found");
      return blog;
    },

    listPolicies() {
      return repository.listPolicies();
    },

    async getPolicy(slug) {
      const policy = await repository.getPolicy(requireSlug(slug));
      if (!policy) throw new HttpError(404, "POLICY_NOT_FOUND", "Policy not found");
      return policy;
    },

    async getStaticPage(slug) {
      const page = await repository.getStaticPage(requireSlug(slug));
      if (!page) throw new HttpError(404, "STATIC_PAGE_NOT_FOUND", "Static page not found");
      return page;
    }
  };
}

function requireSlug(value: string): string {
  const slug = sanitizeSlug(value);
  if (!slug) throw new HttpError(422, "VALIDATION_ERROR", "Invalid slug");
  return slug;
}

function sanitizeSlug(value: unknown): string {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 120);
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
