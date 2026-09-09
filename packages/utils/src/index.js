export function formatVnd(value) {
  return `${Number(value || 0).toLocaleString("vi-VN")}d`;
}

export function toSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function nowIso() {
  return new Date().toISOString();
}

export function pick(source, keys) {
  return keys.reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
    return result;
  }, {});
}
