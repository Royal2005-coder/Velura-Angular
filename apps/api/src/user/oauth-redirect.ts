import { config } from "../config.js";
import { HttpError } from "../http.js";

/**
 * Validate and canonicalize OAuth callback URLs strictly to `<allowed-origin>/auth/callback`
 * without query strings, fragments, or embedded credentials.
 */
export function validatedOAuthRedirect(raw: string): string {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "OAuth redirect must be an absolute URL");
  }
  const isKnownOrigin =
    config.corsOrigins.includes(target.origin) ||
    Boolean(config.storefrontOrigin && target.origin === config.storefrontOrigin) ||
    [
      "https://velura.royalai.dev",
      "https://admin-erp.royalai.dev",
      "https://admin.royalai.dev",
    ].includes(target.origin) ||
    (config.nodeEnv !== "production" &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(target.origin));

  if (
    !isKnownOrigin ||
    target.pathname !== "/auth/callback" ||
    target.search !== "" ||
    target.hash !== "" ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `OAuth redirect origin '${target.origin}' is not allowed or path is not clean /auth/callback`
    );
  }
  return `${target.origin}/auth/callback`;
}
