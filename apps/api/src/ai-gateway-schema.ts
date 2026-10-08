import { HttpError } from "./http.js";
import { isJsonObject, type JsonObject } from "./types.js";

const supported: Record<string, true> = Object.fromEntries(["type", "properties", "required", "items", "enum", "nullable", "additionalProperties", "description", "title", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "anyOf"].map((key) => [key, true]));
const types: Record<string, true> = { object: true, array: true, string: true, number: true, integer: true, boolean: true, null: true };

/** Normalizes the supported Gemini/JSON Schema subset; rejects keywords we cannot enforce. */
export function normalizeOutputSchema(input: unknown, depth = 0): JsonObject {
  if (!isJsonObject(input) || depth > 24) invalidSchema();
  const schema: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(supported, key)) invalidSchema();
    if (key === "type") {
      if (typeof value !== "string" || !Object.hasOwn(types, value.toLowerCase())) invalidSchema();
      schema.type = value.toLowerCase();
    } else if (key === "properties") {
      if (!isJsonObject(value)) invalidSchema();
      schema.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeOutputSchema(child, depth + 1)]));
    } else if (key === "items") {
      schema.items = normalizeOutputSchema(value, depth + 1);
    } else if (key === "anyOf") {
      if (!Array.isArray(value) || !value.length || value.length > 20) invalidSchema();
      schema.anyOf = value.map((child) => normalizeOutputSchema(child, depth + 1));
    } else if (key === "required") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalidSchema();
      schema.required = value;
    } else if (key === "enum") {
      if (!Array.isArray(value) || !value.length || value.some((item) => item !== null && !["string", "number", "boolean"].includes(typeof item))) invalidSchema();
      schema.enum = value;
    } else if (key === "additionalProperties") {
      schema.additionalProperties = typeof value === "boolean" ? value : normalizeOutputSchema(value, depth + 1);
    } else if (key === "nullable") {
      if (typeof value !== "boolean") invalidSchema();
      schema.nullable = value;
    } else if (["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"].includes(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) invalidSchema();
      if (key.startsWith("minI") || key.startsWith("maxI") || key.endsWith("Length")) {
        if (!Number.isInteger(value) || value < 0) invalidSchema();
      }
      schema[key] = value;
    } else {
      if (typeof value !== "string") invalidSchema();
      schema[key] = value;
    }
  }
  if (!schema.type && !schema.anyOf && !schema.enum) invalidSchema();
  if (schema.type === "array" && !schema.items) invalidSchema();
  if (schema.required && (!isJsonObject(schema.properties) || (schema.required as string[]).some((key) => !Object.hasOwn(schema.properties as object, key)))) invalidSchema();
  return schema;
}

/** Validates decoded provider JSON locally; failure never includes generated content. */
export function validateOutput(value: unknown, schema: JsonObject): void {
  if (!matches(value, schema)) {
    throw new HttpError(502, "AI_OUTPUT_SCHEMA_INVALID", "AI output does not match the requested schema");
  }
}

function matches(value: unknown, schema: JsonObject): boolean {
  if (value === null && schema.nullable === true) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => isJsonObject(child) && matches(value, child))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string":
      return typeof value === "string" && within(value.length, schema.minLength, schema.maxLength);
    case "integer":
    case "number":
      return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && within(value, schema.minimum, schema.maximum);
    case "array":
      return Array.isArray(value) && within(value.length, schema.minItems, schema.maxItems) && isJsonObject(schema.items) && value.every((item) => matches(item, schema.items as JsonObject));
    case "object": {
      if (!isJsonObject(value)) return false;
      const properties = isJsonObject(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) {
          if (!isJsonObject(properties[key]) || !matches(item, properties[key] as JsonObject)) return false;
        } else if (schema.additionalProperties === false) return false;
        else if (isJsonObject(schema.additionalProperties) && !matches(item, schema.additionalProperties)) return false;
      }
      return true;
    }
    default: return true;
  }
}

function within(value: number, min: unknown, max: unknown): boolean {
  return (typeof min !== "number" || value >= min) && (typeof max !== "number" || value <= max);
}

function invalidSchema(): never {
  throw new HttpError(400, "AI_SCHEMA_UNSUPPORTED", "AI output schema uses an unsupported or invalid shape");
}
