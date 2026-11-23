// Astro's base config prefixes built routes automatically, but hand-written
// absolute hrefs (nav, footer, cross-links, preloaded assets) need the prefix
// applied explicitly. BASE_URL always has a trailing slash (e.g. "/").
export const BASE: string = import.meta.env.BASE_URL;
