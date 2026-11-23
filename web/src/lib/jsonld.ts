// Schema.org JSON-LD builders. Pure functions over plain data: no Astro
// imports, so the same module can feed any static site (reusable beyond
// Canon). Every node gets a stable @id so pages can point at each other's
// nodes (a TechArticle's publisher is the home page's Organization).
//
// Rule: only facts the repository can source. No aggregateRating, offers,
// softwareVersion or dates — see src/lib/site.ts.

export type Crumb = { name: string; url: string };
type Node = Record<string, unknown>;

export function organization(o: { origin: string; name: string; logo?: string; sameAs?: string[] }): Node {
  return {
    "@type": "Organization",
    "@id": `${o.origin}/#organization`,
    name: o.name,
    url: `${o.origin}/`,
    ...(o.logo && { logo: { "@type": "ImageObject", url: o.logo } }),
    ...(o.sameAs?.length && { sameAs: o.sameAs }),
  };
}

export function softwareApplication(a: {
  origin: string; name: string; description: string; category: string;
  requirements?: string; image?: string; license?: string;
}): Node {
  return {
    "@type": "SoftwareApplication",
    "@id": `${a.origin}/#software`,
    name: a.name,
    description: a.description,
    url: `${a.origin}/`,
    applicationCategory: a.category,
    ...(a.requirements && { softwareRequirements: a.requirements }),
    ...(a.image && { image: a.image }),
    ...(a.license && { license: a.license }),
    publisher: { "@id": `${a.origin}/#organization` },
  };
}

export function techArticle(t: { origin: string; url: string; headline: string; description: string; image?: string }): Node {
  return {
    "@type": "TechArticle",
    "@id": `${t.url}#article`,
    headline: t.headline,
    description: t.description,
    url: t.url,
    mainEntityOfPage: t.url,
    inLanguage: "en",
    ...(t.image && { image: t.image }),
    about: { "@id": `${t.origin}/#software` },
    publisher: { "@id": `${t.origin}/#organization` },
  };
}

export function breadcrumbList(url: string, crumbs: Crumb[]): Node {
  return {
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })),
  };
}

/** One <script type="application/ld+json"> body; "<" is escaped so no string can close the tag. */
export function graph(nodes: Node[]): string {
  return JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replace(/</g, "\\u003c");
}
