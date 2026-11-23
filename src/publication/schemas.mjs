// publication/v1 schemas (docs/v2/publication-protocol.md). Each schema is a JSON
// Schema (draft 2020-12 subset) document; `validate` is a small in-repo evaluator for
// exactly the keywords used here (type, required, properties, additionalProperties,
// enum, const, pattern, minimum, maxLength, items, oneOf), so no dependency is added.
import { CODES, PublicationError } from './errors.mjs';

const CONTENT_ID = '^sha256-[0-9a-f]{64}$';
const HEX64 = '^[0-9a-f]{64}$';
const ALIAS_NAME = '^[a-z0-9][a-z0-9-]{0,62}$';
const OBJECT_KEY = '^(p/sha256-[0-9a-f]{64}/[A-Za-z0-9._/-]{1,200}|aliases/[a-z0-9][a-z0-9-]{0,62}\\.json|receipts/[A-Za-z0-9._-]{1,120}\\.json)$';
const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';

export const SCHEMAS = {
  'alias/v1': {
    $id: 'alias/v1',
    type: 'object',
    required: ['schema', 'name', 'contentId', 'generation', 'previousContentId'],
    additionalProperties: false,
    properties: {
      schema: { const: 'alias/v1' },
      name: { type: 'string', pattern: ALIAS_NAME },
      contentId: { type: 'string', pattern: CONTENT_ID },
      generation: { type: 'integer', minimum: 1 },
      previousContentId: { oneOf: [{ type: 'null' }, { type: 'string', pattern: CONTENT_ID }] },
    },
  },
  'report-publication/v1': {
    $id: 'report-publication/v1',
    description: 'Optional report/v1 extension. Absent means classification private-review and dataOrigin production; a V1 report without it builds byte-identical packets.',
    type: 'object',
    additionalProperties: false,
    properties: {
      classification: { enum: ['public', 'private-review', 'confidential'] },
      dataOrigin: { enum: ['synthetic', 'production'] },
    },
  },
  'publication-targets/v1': {
    $id: 'publication-targets/v1',
    description: 'Target configuration. Holds names and non-secret settings only; credentials come from the environment variable named by credentialEnv.',
    type: 'object',
    required: ['schema', 'targets'],
    additionalProperties: false,
    properties: {
      schema: { const: 'publication-targets/v1' },
      targets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'kind', 'accessMode', 'costCeilingUsdPerMonth'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', pattern: '^[a-z0-9][a-z0-9:-]{0,62}$' },
            kind: { enum: ['fs', 'mock-cloudflare', 'cloudflare'] },
            root: { type: 'string', maxLength: 1024 },
            stateDir: { type: 'string', maxLength: 1024 },
            ledgerDir: { type: 'string', maxLength: 1024 },
            accessMode: { enum: ['local', 'access-private', 'public'] },
            costCeilingUsdPerMonth: { type: 'number', minimum: 0 },
            credentialEnv: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
            endpoint: { type: 'string', pattern: '^https://', maxLength: 256 },
            targetId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
            allowProductionData: { type: 'boolean' },
            allowCustomDomain: { type: 'boolean' },
          },
        },
      },
    },
  },
  'adapter-put-request/v1': {
    $id: 'adapter-put-request/v1',
    type: 'object',
    required: ['key', 'sha256', 'bytes', 'contentType', 'cacheControl'],
    additionalProperties: false,
    properties: {
      key: { type: 'string', pattern: OBJECT_KEY },
      sha256: { type: 'string', pattern: HEX64 },
      bytes: { type: 'integer', minimum: 0 },
      contentType: { type: 'string', maxLength: 100 },
      cacheControl: { type: 'string', maxLength: 100 },
    },
  },
  'adapter-put-result/v1': {
    $id: 'adapter-put-result/v1',
    type: 'object',
    required: ['outcome'],
    additionalProperties: false,
    properties: {
      outcome: { enum: ['created', 'identical', 'conflict'] },
      existingSha256: { type: 'string', pattern: HEX64 },
    },
  },
  'adapter-head-result/v1': {
    $id: 'adapter-head-result/v1',
    type: 'object',
    required: ['exists'],
    additionalProperties: false,
    properties: {
      exists: { type: 'boolean' },
      bytes: { type: 'integer', minimum: 0 },
      sha256: { type: 'string', pattern: HEX64 },
      contentType: { type: 'string' },
      cacheControl: { type: 'string' },
    },
  },
  'adapter-cas-result/v1': {
    $id: 'adapter-cas-result/v1',
    type: 'object',
    required: ['ok'],
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      record: { $ref: 'alias/v1' },
      currentGeneration: { type: 'integer', minimum: 0 },
    },
  },
  'receipt/v2': {
    $id: 'receipt/v2',
    description: 'Append-only publication receipt. Never contains a secret, token, signed URL or cookie (docs/v2/threat-model.md T1).',
    type: 'object',
    required: ['schema', 'receiptId', 'operation', 'target', 'targetKind', 'contentId', 'startedAt', 'finishedAt', 'state', 'transitions', 'objects', 'readBack', 'requestCount', 'bytesUploaded', 'estimatedCostUsd', 'credentialClass', 'toolVersion'],
    additionalProperties: false,
    properties: {
      schema: { const: 'receipt/v2' },
      receiptId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,120}$' },
      operation: { enum: ['publish', 'promote', 'rollback', 'reconcile'] },
      phase: { enum: ['intent', 'result'] },
      target: { type: 'string' },
      targetKind: { enum: ['fs', 'mock-cloudflare', 'cloudflare'] },
      contentId: { oneOf: [{ type: 'null' }, { type: 'string', pattern: CONTENT_ID }] },
      aliasName: { type: 'string', pattern: ALIAS_NAME },
      fromGeneration: { type: 'integer', minimum: 0 },
      toGeneration: { type: 'integer', minimum: 0 },
      startedAt: { type: 'string', pattern: ISO },
      finishedAt: { type: 'string', pattern: ISO },
      state: { enum: ['PLANNED', 'UPLOADING', 'UPLOADED', 'READBACK_VERIFIED', 'PROMOTING', 'PROMOTED', 'RECONCILED', 'PARTIAL', 'CONFLICT', 'READBACK_MISMATCH', 'ALIAS_CONFLICT', 'THROTTLED', 'TIMEOUT', 'CREDENTIAL_EXPIRED', 'TARGET_NOT_VERIFIED', 'REFUSED', 'RECEIPT_FAILED', 'HISTORY_INCOMPLETE', 'FAILED'] },
      transitions: { type: 'array', items: { type: 'string' } },
      objects: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'sha256', 'bytes', 'outcome'],
          additionalProperties: false,
          properties: { key: { type: 'string' }, sha256: { type: 'string', pattern: HEX64 }, bytes: { type: 'integer', minimum: 0 }, outcome: { enum: ['created', 'identical', 'conflict', 'not-attempted'] } },
        },
      },
      readBack: {
        type: 'object',
        required: ['verified', 'mismatches'],
        additionalProperties: false,
        properties: { verified: { type: 'boolean' }, mismatches: { type: 'array', items: { type: 'string' } } },
      },
      errorClass: { type: 'string' },
      requestCount: { type: 'integer', minimum: 0 },
      bytesUploaded: { type: 'integer', minimum: 0 },
      estimatedCostUsd: { type: 'number', minimum: 0 },
      credentialClass: { enum: ['none', 'access-service-token', 'publisher-signing-key'] },
      toolVersion: { type: 'string' },
      productionAcknowledged: { type: 'boolean' },
      // render-policy-2.md R12: present only on a publish that admitted a render-policy/1
      // packet because --allow-render-policy-1 was given after the default moved.
      admissionOverride: {
        type: 'object',
        required: ['flag', 'renderPolicy', 'defaultRenderPolicy'],
        additionalProperties: false,
        properties: { flag: { const: 'allow-render-policy-1' }, renderPolicy: { const: 'render-policy/1' }, defaultRenderPolicy: { type: 'string', pattern: '^render-policy/[0-9]+$' } },
      },
    },
  },
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

// Returns a list of problems ([] when valid).
export function validate(schemaOrId, value, path = '') {
  const schema = typeof schemaOrId === 'string' ? SCHEMAS[schemaOrId] : schemaOrId;
  if (!schema) throw new Error(`unknown schema ${schemaOrId}`);
  if (schema.$ref) return validate(schema.$ref, value, path);
  const out = [];
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validate(s, value, path).length === 0).length;
    if (passing !== 1) out.push(`${path || '/'}: must match exactly one alternative`);
    return out;
  }
  if ('const' in schema && value !== schema.const) out.push(`${path || '/'}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path || '/'}: must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const t = typeOf(value);
    const ok = schema.type === t || (schema.type === 'number' && (t === 'integer' || t === 'number'));
    if (!ok) { out.push(`${path || '/'}: expected ${schema.type}, got ${t}`); return out; }
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${path || '/'}: does not match ${schema.pattern}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path || '/'}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push(`${path || '/'}: below ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => out.push(...validate(schema.items, item, `${path}/${i}`)));
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) out.push(`${path}/${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, k)) out.push(...validate(schema.properties[k], v, `${path}/${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}/${k}: not allowed`);
    }
  }
  return out;
}

export function assertValid(schemaId, value, what = schemaId) {
  const problems = validate(schemaId, value);
  if (problems.length) throw new PublicationError(CODES.INVALID, `${what}: ${problems.join('; ')}`, { problems });
  return value;
}
