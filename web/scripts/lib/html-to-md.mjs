// Small, dependency-free HTML → Markdown converter for static-site output.
//
// Scope: well-formed HTML produced by a site generator (Astro here), not
// arbitrary web pages. It has a tokenizer, a tree builder that tolerates
// unclosed <p>/<li>, and a renderer for the elements docs pages use:
// headings, paragraphs, lists, pre/code, inline code, links, emphasis,
// tables (GFM), blockquotes, figures, images and line breaks. Unknown
// elements are treated as transparent: block if the tag is block-level,
// inline otherwise.
//
// Site-specific behaviour goes through `options`, so the module itself stays
// generic (reusable beyond Canon):
//   ignore(el)     → true to drop an element and its subtree
//   codeBlock(el)  → true to render an inline element as one line of a fenced
//                    block (consecutive ones merge into a single block)
//   transform(root, h) → mutate the tree before rendering (h = helpers)
//   baseUrl        → absolute URL that relative hrefs/srcs resolve against

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const SKIP = new Set(["script", "style", "template", "noscript", "svg", "button", "input", "select", "textarea", "head"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html",
  "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
// Opening one of these closes an open <p>; opening <li> closes an open <li>.
const CLOSES_P = new Set([...BLOCK].filter((t) => !["dd", "dt", "td", "th", "tr", "tbody", "thead", "tfoot", "li", "summary"].includes(t)));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←", middot: "·", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** Parse HTML into a tree of { tag, attrs, children, parent } / { text }. */
export function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</gi;
  let m;
  const close = (tag) => {
    for (let n = cur; n && n !== root; n = n.parent) {
      if (n.tag === tag) { cur = n.parent; return; }
    }
  };
  while ((m = re.exec(html))) {
    const [all, endTag, startTag, attrSrc, selfClose] = m;
    if (all.startsWith("<!")) continue;
    if (endTag) { close(endTag.toLowerCase()); continue; }
    if (startTag) {
      const tag = startTag.toLowerCase();
      if (cur.tag === "p" && CLOSES_P.has(tag)) cur = cur.parent;
      if (tag === "li") close("li");
      const el = { tag, attrs: parseAttrs(attrSrc ?? ""), children: [], parent: cur };
      cur.children.push(el);
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        const stop = end < 0 ? html.length : end;
        el.children.push({ text: html.slice(re.lastIndex, stop), parent: el });
        re.lastIndex = stop;
        continue;
      }
      if (!VOID.has(tag) && !selfClose) cur = el;
      continue;
    }
    cur.children.push({ text: decode(all), parent: cur });
  }
  return root;
}

// ---- tree helpers -----------------------------------------------------------
export const helpers = {
  classes: (el) => (el.attrs?.class ?? "").split(/\s+/).filter(Boolean),
  hasClass: (el, c) => helpers.classes(el).includes(c),
  find(el, pred) {
    if (el.tag && pred(el)) return el;
    for (const c of el.children ?? []) { const r = helpers.find(c, pred); if (r) return r; }
    return null;
  },
  findAll(el, pred, out = []) {
    if (el.tag && pred(el)) out.push(el);
    for (const c of el.children ?? []) helpers.findAll(c, pred, out);
    return out;
  },
  text: (el) => (el.text != null ? el.text : (el.children ?? []).map(helpers.text).join("")),
  remove(el) { const s = el.parent.children; s.splice(s.indexOf(el), 1); },
};

// ---- renderer ---------------------------------------------------------------
const collapse = (s) => s.replace(/[ \t\r\n\f]+/g, " ");
// Emphasis, code and link syntax are escaped in text. Angle brackets are left
// raw on purpose: the output is read as plain text by agents, and "<alias>"
// reads better than "\<alias>". A Markdown renderer may treat "<alias>" as an
// HTML tag; Canon's own Markdown twins (the planned source swap) will own that.
const escapeInline = (s) => s.replace(/([\\`*_\[\]])/g, "\\$1");
// A paragraph line that would start a list or heading gets its marker escaped.
const escapeLineStart = (s) => s.replace(/^([#>+-]|\d+\.)(?= )/gm, "\\$1");

export function htmlToMarkdown(html, options = {}) {
  const { ignore = () => false, codeBlock = () => false, transform, baseUrl } = options;
  const root = typeof html === "string" ? parse(html) : html;
  if (transform) transform(root, helpers);

  const skip = (el) => SKIP.has(el.tag) || el.attrs["aria-hidden"] === "true" || el.attrs.hidden != null || ignore(el);
  const resolve = (u) => { try { return baseUrl ? new URL(u, baseUrl).href : u; } catch { return u; } };
  const isBlock = (el) => BLOCK.has(el.tag) || codeBlock(el);

  function inline(node) {
    if (node.text != null) return escapeInline(collapse(node.text));
    if (skip(node)) return "";
    const inner = () => node.children.map(inline).join("");
    switch (node.tag) {
      case "br": return "\n";
      case "code": case "kbd": case "samp": {
        const t = collapse(helpers.text(node)).trim();
        if (!t) return "";
        const ticks = t.includes("`") ? "``" : "`";
        return `${ticks}${ticks.length > 1 ? " " : ""}${t}${ticks.length > 1 ? " " : ""}${ticks}`;
      }
      case "strong": case "b": { const t = inner().trim(); return t ? `**${t}**` : ""; }
      case "em": case "i": { const t = inner().trim(); return t ? `*${t}*` : ""; }
      case "a": {
        const t = inner().trim();
        const href = node.attrs.href;
        if (!href || !t) return t;
        return `[${t}](${resolve(href)})`;
      }
      case "img": return node.attrs.alt ? `![${node.attrs.alt}](${resolve(node.attrs.src ?? "")})` : "";
      default: return inner();
    }
  }

  const tidy = (s) => s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").trim();

  // Render a container's children as a list of Markdown blocks.
  function blocks(el) {
    const out = [];
    let run = "";
    let codeRun = null;
    const flush = () => {
      const t = tidy(run);
      if (t) out.push(t);
      run = "";
    };
    const flushCode = () => {
      if (codeRun) out.push("```\n" + codeRun.join("\n") + "\n```");
      codeRun = null;
    };
    for (const c of el.children) {
      if (c.text != null) { if (c.text.trim() || run) run += inline(c); continue; }
      if (skip(c)) continue;
      if (codeBlock(c)) {
        flush();
        (codeRun ??= []).push(collapse(helpers.text(c)).trim());
        continue;
      }
      if (codeRun && !/^\s*$/.test(helpers.text(c))) flushCode();
      if (!isBlock(c)) { run += inline(c); continue; }
      flush();
      flushCode();
      out.push(...block(c));
    }
    flush();
    flushCode();
    return out;
  }

  function block(el) {
    const t = el.tag;
    if (/^h[1-6]$/.test(t)) {
      const s = tidy(el.children.map(inline).join("")).replace(/\n/g, " ");
      return s ? [`${"#".repeat(Number(t[1]))} ${s}`] : [];
    }
    if (t === "p" || t === "summary" || t === "dt") { const s = escapeLineStart(tidy(el.children.map(inline).join(""))); return s ? [s] : []; }
    if (t === "hr") return ["---"];
    if (t === "pre") {
      const code = helpers.find(el, (n) => n.tag === "code") ?? el;
      const body = helpers.text(code).replace(/^\n/, "").replace(/\s+$/, "");
      const fence = body.includes("```") ? "````" : "```";
      return [`${fence}\n${body}\n${fence}`];
    }
    if (t === "ul" || t === "ol") {
      let n = Number(el.attrs.start ?? 1);
      const items = el.children.filter((c) => c.tag === "li" && !skip(c)).map((li) => {
        const marker = t === "ol" ? `${n++}.` : "-";
        const body = blocks(li).join("\n\n");
        const pad = " ".repeat(marker.length + 1);
        return `${marker} ${body.split("\n").join(`\n${pad}`).replace(new RegExp(`\\n${pad}(?=\\n)`, "g"), "\n")}`;
      });
      return items.length ? [items.join("\n")] : [];
    }
    if (t === "blockquote") {
      const inner = blocks(el).join("\n\n");
      return inner ? [inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")] : [];
    }
    if (t === "table") {
      const rows = helpers.findAll(el, (n) => n.tag === "tr" && !skip(n) && !hasSkippedAncestor(n, el));
      const cells = rows.map((r) => r.children.filter((c) => (c.tag === "td" || c.tag === "th") && !skip(c))
        .map((c) => tidy(c.children.map(inline).join("")).replace(/\n/g, " ").replace(/\|/g, "\\|")));
      if (!cells.length) return [];
      const width = Math.max(...cells.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      const caption = helpers.find(el, (n) => n.tag === "caption");
      const head = caption ? [tidy(caption.children.map(inline).join(""))] : [];
      return [...head, [line(cells[0]), `|${" --- |".repeat(width)}`, ...cells.slice(1).map(line)].join("\n")];
    }
    if (t === "figcaption") { const s = tidy(el.children.map(inline).join("")); return s ? [s] : []; }
    return blocks(el);
  }

  function hasSkippedAncestor(n, stop) {
    for (let p = n.parent; p && p !== stop; p = p.parent) if (p.tag && skip(p)) return true;
    return false;
  }

  return blocks(root).join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
