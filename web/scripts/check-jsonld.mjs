// Validates every <script type="application/ld+json"> in a built site against
// the schema.org vocabulary itself (classes, properties, domains, ranges),
// offline. Generic: works on any static site's dist/.
//
//   curl -fsSLo /tmp/schemaorg.jsonld https://schema.org/version/latest/schemaorg-current-https.jsonld
//   node scripts/check-jsonld.mjs --vocab /tmp/schemaorg.jsonld [--dist dist]
//
// Checks, per node: the JSON parses; @context is https://schema.org; @type is
// a schema.org class; each property exists and lists the type (or one of its
// superclasses) in domainIncludes; each value fits rangeIncludes (Text/URL/
// Number/Integer/Boolean literals, or nested nodes of an allowed class, or an
// {"@id"} reference that resolves on some page of the site); every @id is
// defined once. Also Google's required fields for BreadcrumbList. Exit 1 on
// any error.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
if (!args.vocab) { console.error("usage: check-jsonld.mjs --vocab <schemaorg-current-https.jsonld> [--dist dist]"); process.exit(2); }
const dist = resolve(args.dist ?? "dist");

// ---- vocabulary -------------------------------------------------------------
const graph = JSON.parse(readFileSync(args.vocab, "utf8"))["@graph"];
const ids = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map((x) => x["@id"].replace(/^schema:/, "")));
const classes = new Map(); // name -> superclasses
const props = new Map();   // name -> { domain, range }
for (const n of graph) {
  const types = [].concat(n["@type"]);
  const name = n["@id"].replace(/^schema:/, "");
  if (types.includes("rdfs:Class")) classes.set(name, ids(n["rdfs:subClassOf"]));
  if (types.includes("rdf:Property")) props.set(name, { domain: ids(n["schema:domainIncludes"]), range: ids(n["schema:rangeIncludes"]) });
}
const ancestors = (c, seen = new Set()) => {
  if (seen.has(c)) return seen;
  seen.add(c);
  for (const s of classes.get(c) ?? []) ancestors(s, seen);
  return seen;
};
const isA = (c, target) => ancestors(c).has(target);

// ---- read the site ----------------------------------------------------------
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : []; });
const errors = [];
const nodes = []; // { page, node }
const defined = new Map();
for (const file of walk(dist)) {
  const html = readFileSync(file, "utf8");
  const page = relative(dist, file);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch (e) { errors.push(`${page}: JSON parse error: ${e.message}`); continue; }
    if (doc["@context"] !== "https://schema.org") errors.push(`${page}: @context is ${JSON.stringify(doc["@context"])}`);
    for (const node of doc["@graph"] ?? [doc]) {
      nodes.push({ page, node });
      if (node["@id"]) {
        if (defined.has(node["@id"]) && defined.get(node["@id"]) !== page) errors.push(`${page}: @id ${node["@id"]} also defined on ${defined.get(node["@id"])}`);
        defined.set(node["@id"], page);
      }
    }
  }
}

// ---- check ------------------------------------------------------------------
const LITERAL = {
  Text: (v) => typeof v === "string",
  URL: (v) => typeof v === "string" && /^https?:\/\//.test(v),
  Number: (v) => typeof v === "number",
  Integer: (v) => Number.isInteger(v),
  Boolean: (v) => typeof v === "boolean",
};
const refs = [];
function checkNode(page, node, path) {
  const type = node["@type"];
  if (!type) { errors.push(`${page} ${path}: node without @type`); return; }
  if (!classes.has(type)) { errors.push(`${page} ${path}: @type ${type} is not a schema.org class`); return; }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@")) continue;
    const p = props.get(key);
    if (!p) { errors.push(`${page} ${path}.${key}: not a schema.org property`); continue; }
    if (!p.domain.some((d) => isA(type, d))) errors.push(`${page} ${path}.${key}: not a property of ${type} (domain ${p.domain.join(", ")})`);
    for (const [i, v] of (Array.isArray(value) ? value : [value]).entries()) {
      const at = Array.isArray(value) ? `${path}.${key}[${i}]` : `${path}.${key}`;
      if (v && typeof v === "object") {
        if (v["@id"] && !v["@type"]) { refs.push({ page, at, id: v["@id"], range: p.range }); continue; }
        if (!p.range.some((r) => isA(v["@type"], r))) errors.push(`${page} ${at}: ${v["@type"]} not in range ${p.range.join(", ")}`);
        checkNode(page, v, at);
      } else {
        // Text-like literals: schema.org lets URL values stand for Thing references.
        const ok = p.range.some((r) => LITERAL[r]?.(v)) || (typeof v === "string" && /^https?:\/\//.test(v) && p.range.some((r) => classes.has(r)));
        if (!ok) errors.push(`${page} ${at}: ${JSON.stringify(v)} doesn't fit range ${p.range.join(", ")}`);
      }
    }
  }
  if (type === "BreadcrumbList") {
    const items = node.itemListElement ?? [];
    if (!items.length) errors.push(`${page} ${path}: BreadcrumbList without itemListElement`);
    items.forEach((li, i) => {
      if (li.position !== i + 1) errors.push(`${page} ${path}.itemListElement[${i}]: position ${li.position}, expected ${i + 1}`);
      if (!li.name) errors.push(`${page} ${path}.itemListElement[${i}]: missing name`);
      if (!li.item && i < items.length - 1) errors.push(`${page} ${path}.itemListElement[${i}]: missing item`);
    });
  }
}
for (const { page, node } of nodes) checkNode(page, node, node["@type"] ?? "?");
for (const r of refs) {
  const target = nodes.find((n) => n.node["@id"] === r.id);
  if (!target) { errors.push(`${r.page} ${r.at}: @id ${r.id} isn't defined on any page`); continue; }
  if (!r.range.some((c) => isA(target.node["@type"], c))) errors.push(`${r.page} ${r.at}: ${r.id} is a ${target.node["@type"]}, not in range ${r.range.join(", ")}`);
}

const types = [...new Set(nodes.map((n) => n.node["@type"]))].join(", ");
const pages = new Set(nodes.map((n) => n.page)).size;
if (errors.length) { console.error(errors.join("\n")); console.error(`check-jsonld: ${errors.length} error(s)`); process.exit(1); }
console.log(`check-jsonld: ${nodes.length} nodes (${types}) on ${pages} pages; all types, properties, ranges and @id references valid against schema.org (${classes.size} classes, ${props.size} properties)`);
