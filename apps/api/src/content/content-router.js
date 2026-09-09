import { sendJson } from "../http.js";

export async function handleContentRoute({ req, res, url, parts, headers, service }) {
  if (parts[0] !== "api" || parts[1] !== "content") return false;

  if (req.method === "GET" && parts[2] === "categories" && parts.length === 3) {
    sendJson(res, 200, await service.listCategories(url.searchParams), headers);
    return true;
  }

  if (parts[2] === "blogs") {
    if (req.method === "GET" && parts.length === 3) {
      sendJson(res, 200, await service.listBlogs(url.searchParams), headers);
      return true;
    }
    if (req.method === "GET" && parts[3] && parts.length === 4) {
      sendJson(res, 200, await service.getBlog(parts[3]), headers);
      return true;
    }
  }

  if (parts[2] === "policies") {
    if (req.method === "GET" && parts.length === 3) {
      sendJson(res, 200, await service.listPolicies(), headers);
      return true;
    }
    if (req.method === "GET" && parts[3] && parts.length === 4) {
      sendJson(res, 200, await service.getPolicy(parts[3]), headers);
      return true;
    }
  }

  if (req.method === "GET" && parts[2] === "pages" && parts[3] && parts.length === 4) {
    sendJson(res, 200, await service.getStaticPage(parts[3]), headers);
    return true;
  }

  return false;
}
