// Checks the built site for the two things Homebrew and Sparkle installs
// depend on (release pipeline, web/install-brew):
//   1. dist/appcast.xml is well-formed XML: an RSS 2.0 root that declares the
//      Sparkle namespace, and one channel titled "Canon" that links to
//      https://oncanon.com/. Canon.app's SUFeedURL reads this file.
//   2. dist/_headers serves /appcast.xml as application/rss+xml with
//      Cache-Control max-age=300.
//   3. The install guide shows the cask command, then the formula command,
//      and only after both, the source install (git clone).
// Usage: node scripts/check-install-feed.mjs [--dist dist]
// Exits 1 with one line per failure.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle";
export const CASK = "brew install --cask oncanon/tap/canon-app";
export const FORMULA = "brew install oncanon/tap/canon";
export const SOURCE = "git clone";

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g;
const CHAR_REF = /&#(?:(\d+)|x([0-9A-Fa-f]+));/g;
// XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
// With the u flag a lone surrogate is one code point, so it matches too.
const NOT_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const isChar = (c) =>
  c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
const hex = (c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Parses an XML document into a tree of { name, attrs, children, text }.
 * It throws on these, which an XML 1.0 parser rejects as not well-formed:
 * - a character outside the XML Char range anywhere in the document;
 * - an XML declaration anywhere but at the very start (after an optional BOM);
 * - unbalanced or crossed tags, a malformed end tag, more than one root, and
 *   text or CDATA outside the root;
 * - duplicate or unquoted attributes, and bad element or attribute names;
 * - a bare "&" or "<", an unknown entity, a character reference to a
 *   character outside the XML Char range, and "]]>" in text;
 * - "--" inside a comment, or a comment that ends "--->";
 * - an undeclared namespace prefix.
 * Deliberate restriction: it also rejects every DOCTYPE, though XML allows
 * one. The appcast has no DTD, Sparkle needs none, and a DTD is how a feed
 * declares entities or pulls in external files, so the check refuses it
 * rather than reading it.
 */
export function parseXml(src) {
  let i = 0;
  const root = { name: "#document", attrs: {}, children: [], text: "", ns: { xml: "http://www.w3.org/XML/1998/namespace" } };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const fail = (msg) => {
    const line = src.slice(0, i).split("\n").length;
    throw new Error(`line ${line}: ${msg}`);
  };
  const checkRefs = (t, where) => {
    for (const [ref, dec, hx] of t.matchAll(CHAR_REF)) {
      const c = dec !== undefined ? Number(dec) : parseInt(hx, 16);
      if (!isChar(c)) fail(`character reference ${ref} in ${where} is not an XML character`);
    }
  };
  const checkText = (t) => {
    if (t.includes("<")) fail("bare '<' in text");
    if (t.includes("]]>")) fail('"]]>" in text');
    if (t.replace(ENTITY, "").includes("&")) fail("bare '&' or unknown entity in text");
    checkRefs(t, "text");
  };
  const bad = NOT_CHAR.exec(src);
  if (bad) {
    i = bad.index;
    fail(`character ${hex(bad[0].codePointAt(0))} is not allowed in XML`);
  }
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  if (src.startsWith("<?xml", i) && /^<\?xml[\s?]/.test(src.slice(i))) {
    const end = src.indexOf("?>", i);
    if (end === -1) fail("unterminated XML declaration");
    i = end + 2;
  }
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) fail("unterminated comment");
      const body = src.slice(i + 4, end);
      if (body.includes("--")) fail("'--' inside a comment");
      if (body.endsWith("-")) fail("comment ends with '--->'");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      if (stack.length === 1) fail("CDATA outside the root element");
      const end = src.indexOf("]]>", i);
      if (end === -1) fail("unterminated CDATA");
      top().text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end === -1) fail("unterminated processing instruction");
      const target = /^<\?([^\s?]*)/.exec(src.slice(i))[1];
      if (target.toLowerCase() === "xml") fail("XML declaration is not at the start of the document");
      if (!NAME.test(target) || target.includes(":")) fail(`bad processing instruction target ${JSON.stringify(target)}`);
      i = end + 2;
    } else if (src.startsWith("<!DOCTYPE", i)) {
      fail("DOCTYPE is not supported (deliberate: the appcast has no DTD)");
    } else if (src.startsWith("<!", i)) {
      fail("malformed markup declaration");
    } else if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      if (end === -1) fail("unterminated end tag");
      const name = src.slice(i + 2, end).trimEnd();
      if (!NAME.test(name)) fail(`malformed end tag </${name}>`);
      if (stack.length === 1) fail(`end tag </${name}> with no open element`);
      if (top().name !== name) fail(`end tag </${name}> does not match <${top().name}>`);
      stack.pop();
      i = end + 1;
    } else if (src[i] === "<") {
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(src.slice(i));
      if (!m) fail("malformed start tag");
      const [whole, name, rawAttrs, selfClose] = m;
      if (!NAME.test(name)) fail(`bad element name ${name}`);
      if (stack.length === 1 && root.children.length) fail(`second root element <${name}>`);
      const attrs = {};
      for (const a of rawAttrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const key = a[1];
        const value = a[2] ?? a[3];
        if (!NAME.test(key)) fail(`bad attribute name ${key}`);
        if (key in attrs) fail(`duplicate attribute ${key} on <${name}>`);
        if (value.replace(ENTITY, "").includes("&")) fail(`bare '&' in attribute ${key}`);
        checkRefs(value, `attribute ${key}`);
        attrs[key] = value;
      }
      const ns = { ...top().ns };
      for (const [k, v] of Object.entries(attrs)) if (k.startsWith("xmlns:")) ns[k.slice(6)] = v;
      for (const qname of [name, ...Object.keys(attrs)]) {
        const prefix = qname.includes(":") ? qname.split(":")[0] : null;
        if (prefix && prefix !== "xmlns" && !(prefix in ns)) fail(`undeclared namespace prefix ${prefix} in ${qname}`);
      }
      const el = { name, attrs, children: [], text: "", ns };
      top().children.push(el);
      if (!selfClose) stack.push(el);
      i += whole.length;
    } else {
      const next = src.indexOf("<", i);
      const end = next === -1 ? src.length : next;
      const t = src.slice(i, end);
      if (stack.length === 1) {
        if (t.trim()) fail("text outside the root element");
      } else {
        checkText(t);
        top().text += t;
      }
      i = end;
    }
  }
  if (stack.length > 1) fail(`<${top().name}> is never closed`);
  if (root.children.length !== 1) fail("no root element");
  return root.children[0];
}

export function checkAppcast(xml) {
  const errors = [];
  let rss;
  try {
    rss = parseXml(xml);
  } catch (e) {
    return [`appcast.xml is not well-formed XML: ${e.message}`];
  }
  if (rss.name !== "rss") errors.push(`appcast.xml root is <${rss.name}>, not <rss>`);
  if (rss.attrs.version !== "2.0") errors.push(`appcast.xml rss version is ${JSON.stringify(rss.attrs.version)}, not "2.0"`);
  if (rss.attrs["xmlns:sparkle"] !== SPARKLE_NS) errors.push(`appcast.xml does not declare xmlns:sparkle="${SPARKLE_NS}" on <rss>`);
  const channels = rss.children.filter((c) => c.name === "channel");
  if (channels.length !== 1) return [...errors, `appcast.xml has ${channels.length} <channel> elements, not 1`];
  const field = (n) => channels[0].children.filter((c) => c.name === n).map((c) => c.text.trim());
  if (field("title").join() !== "Canon") errors.push(`appcast.xml channel title is ${JSON.stringify(field("title"))}, not "Canon"`);
  if (field("link").join() !== "https://oncanon.com/") errors.push(`appcast.xml channel link is ${JSON.stringify(field("link"))}, not "https://oncanon.com/"`);
  return errors;
}

/** Headers that the Cloudflare Pages _headers file gives one exact path. */
export function headersFor(file, path) {
  const out = {};
  let current = null;
  for (const line of file.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      continue;
    }
    if (current !== path) continue;
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

export function checkHeaders(file) {
  const errors = [];
  const h = headersFor(file, "/appcast.xml");
  if (!/^application\/rss\+xml(\s*;|$)/.test(h["content-type"] ?? "")) {
    errors.push(`_headers: /appcast.xml Content-Type is ${JSON.stringify(h["content-type"])}, not application/rss+xml`);
  }
  if (!/(^|[\s,])max-age=300($|[\s,])/.test(h["cache-control"] ?? "")) {
    errors.push(`_headers: /appcast.xml Cache-Control is ${JSON.stringify(h["cache-control"])}, not max-age=300`);
  }
  return errors;
}

/** The visible text of the page's <main>: tags removed, entities decoded. */
export function mainText(html) {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0];
  if (!main) return null;
  return main
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

export function checkInstallOrder(html) {
  const text = mainText(html);
  if (text === null) return ["install guide: no <main>"];
  const at = (s) => text.indexOf(s);
  const errors = [];
  for (const s of [CASK, FORMULA, SOURCE]) if (at(s) === -1) errors.push(`install guide: ${JSON.stringify(s)} is not on the page`);
  if (errors.length) return errors;
  if (!(at(CASK) < at(SOURCE) && at(FORMULA) < at(SOURCE))) errors.push(`install guide: the source install comes before a brew command`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const distAt = argv.indexOf("--dist");
  const dist = resolve(distAt === -1 ? "dist" : argv[distAt + 1]);
  const read = (rel) => {
    const p = join(dist, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const errors = [];
  const xml = read("appcast.xml");
  const headers = read("_headers");
  const install = read("guide/install/index.html");
  if (xml === null) errors.push(`${dist}/appcast.xml is missing`);
  else errors.push(...checkAppcast(xml));
  if (headers === null) errors.push(`${dist}/_headers is missing`);
  else errors.push(...checkHeaders(headers));
  if (install === null) errors.push(`${dist}/guide/install/index.html is missing`);
  else errors.push(...checkInstallOrder(install));
  if (errors.length) {
    for (const e of errors) console.error(`check-install-feed: ${e}`);
    process.exit(1);
  }
  console.log("check-install-feed: appcast.xml is well-formed RSS 2.0 with the Sparkle namespace; /appcast.xml headers ok; install guide shows both brew commands before the source install");
}
