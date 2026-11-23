// The identifier gate for committed source (H-8.1): no account ID, GUID, account ARN, access key,
// email address, private key or secret value appears in a file. Placeholders such as
// <DEV_ACCOUNT_ID> and short commit IDs are fine. Used by test/support/source-identifiers.mjs.
// Real identifiers and secrets that must never appear (placeholders and short commit IDs are fine).
export const IDENTIFIER_PATTERNS = [
  ['an AWS account ID', /(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g],
  ['an account-scoped ARN', /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:/g],
  ['a GUID (Entra tenant, client or resource ID)', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi],
  ['an AWS access key ID', /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
  ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['an Entra client secret value', /[A-Za-z0-9_-]{3}8Q~[A-Za-z0-9_.~-]{30,}/g],
  ['a secret assigned a value', /(?:client_?secret|password|secret_?key|api_?key|token)\s*[:=]\s*["']?[A-Za-z0-9/+=_~.-]{12,}/gi],
];

export function identifierProblems(text) {
  const problems = [];
  text.split('\n').forEach((line, i) => {
    for (const [what, re] of IDENTIFIER_PATTERNS) for (const m of line.matchAll(re)) problems.push(`line ${i + 1}: ${what} (${m[0].length} characters at column ${m.index + 1})`);
  });
  return problems;
}
