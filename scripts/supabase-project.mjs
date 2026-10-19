/** Validate the independently configured production project reference without accepting URLs or credentials. */
export function requireProductionProjectRef(value) {
  if (typeof value !== "string" || !/^[a-z0-9]{20}$/.test(value)) {
    throw new Error("Missing or invalid trusted PRODUCTION_SUPABASE_PROJECT_REF.");
  }
  return value;
}

/** Derive a Supabase DB project from a recognized direct host or pooler postgres.<ref> identity; never echo credentials. */
export function databaseProjectRef(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Unrecognized Supabase database identity.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Unrecognized Supabase database identity.");
  }
  let username;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error("Unrecognized Supabase database identity.");
  }
  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
  if (direct && (/^[a-z_][a-z0-9_]*$/.test(username) || username === `postgres.${direct[1]}`)) {
    return direct[1];
  }
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname);
  const pooledUser = /^postgres\.([a-z0-9]{20})$/.exec(username);
  if (pooler && pooledUser) return pooledUser[1];
  throw new Error("Unrecognized Supabase database identity.");
}

/** Require a recognized staging project distinct from the independently trusted production reference before any connection. */
export function requireStagingProjectRef(databaseUrl, productionRef) {
  const trustedProduction = requireProductionProjectRef(productionRef);
  const staging = databaseProjectRef(databaseUrl);
  if (staging === trustedProduction) {
    throw new Error("Staging database identity matches production; refusing release verification or migration.");
  }
  return staging;
}
