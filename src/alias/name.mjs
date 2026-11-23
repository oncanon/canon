// The alias name grammar, in a module of its own so the packet origin (src/origin/handler.mjs)
// can check names without loading the alias writer and, through it, the packet verifier.
export const ALIAS_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
