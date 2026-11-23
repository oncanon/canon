// Heading anchors. Search links each matched section to its heading's id,
// so every h2/h3 in the docs carries one: lowercase ASCII words joined by "-".
export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
