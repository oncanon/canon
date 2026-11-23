// Canonical JSON for packet identity (see docs/decisions/phase1-contract.md, D1).
//
// Rules: object members sorted by UTF-16 code-unit order of their keys (RFC 8785
// ordering); no insignificant whitespace; strings serialized with ECMAScript
// JSON.stringify escaping; numbers must be finite and are serialized with
// ECMAScript Number::toString (RFC 8785); `undefined`, functions, symbols,
// bigint and non-plain objects are rejected rather than silently dropped.

export class CanonicalJsonError extends Error {
  constructor(message, path) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

function serialize(value, path, depth) {
  if (depth > 64) throw new CanonicalJsonError('nesting too deep', path);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number', path);
      return Object.is(value, -0) ? '0' : String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}/${i}`, depth + 1)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('non-plain object', path);
      }
      const keys = Object.keys(value).sort();
      const members = keys.map((key) => {
        const member = value[key];
        if (member === undefined) throw new CanonicalJsonError(`undefined member "${key}"`, path);
        return `${JSON.stringify(key)}:${serialize(member, `${path}/${key}`, depth + 1)}`;
      });
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value}`, path);
  }
}

export function canonicalize(value) {
  return serialize(value, '', 0);
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}
