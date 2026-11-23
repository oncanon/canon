// Every piece of authored text reaches HTML through one of these functions.
// There is no API that inserts unescaped authored content.

const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => TEXT_ESCAPES[ch]);
}

// Attribute values are always double-quoted by the renderer; escaping the full
// set above keeps them closed regardless of quoting style.
export const escapeAttr = escapeHtml;
