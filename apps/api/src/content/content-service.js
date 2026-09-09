import { HttpError } from "../http.js";

export function createContentService({ repository }) {
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

function requireSlug(value) {
  const slug = sanitizeSlug(value);
  if (!slug) throw new HttpError(422, "VALIDATION_ERROR", "Invalid slug");
  return slug;
}

function sanitizeSlug(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 120);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
