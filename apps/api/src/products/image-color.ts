/** Colour key used to compare a variant colour with a colour embedded in a catalog image file name. */
export function colorKey(color: string): string {
  return color
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Colour slug the catalog image naming convention embeds before the numeric suffix
 * (`<category>_<product>_<color>_<nn>.<ext>`); null when the file name carries none.
 */
export function colorKeyFromImageUrl(url: string): string | null {
  const match = /_([a-z0-9]+(?:-[a-z0-9]+)*)_\d+\.[a-z0-9]+(?:\?.*)?$/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Fills `image_colors` for images the operator did not map explicitly, using the colour in the file name
 * when it equals one of the product's variant colours. Explicit mappings always win.
 */
export function withInferredImageColors(
  images: unknown,
  imageColors: unknown,
  variantColors: string[],
): Record<string, string> {
  const result: Record<string, string> =
    imageColors && typeof imageColors === "object" && !Array.isArray(imageColors)
      ? { ...(imageColors as Record<string, string>) }
      : {};
  const byKey = new Map(variantColors.filter(Boolean).map((name) => [colorKey(name), name]));
  for (const image of Array.isArray(images) ? images : []) {
    if (typeof image !== "string" || result[image] !== undefined) continue;
    const key = colorKeyFromImageUrl(image);
    const name = key ? byKey.get(key) : undefined;
    if (name) result[image] = name;
  }
  return result;
}
