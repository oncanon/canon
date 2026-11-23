// Signed admin requests for the public target (V2.1 slice 04, mode (c)). The canonical
// message is the Worker's own (worker/index.mjs), so publisher and Worker cannot disagree
// about what is signed.
//
// Key text formats (neither is PEM, so neither is mistaken for another key type):
//   private: canon-ed25519-sk:<base64url PKCS#8 DER>  (a secret: the secret gate knows it)
//   public:  canon-ed25519-pk:<base64url raw 32 bytes> (not a secret: the Worker's plain var)
// Errors never include key material.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { CODES, PublicationError } from './errors.mjs';
import { canonicalAdminMessage, PUBLIC_KEY_FORMAT, TARGET_ID_FORMAT } from './worker/index.mjs';

export const PRIVATE_KEY_PREFIX = 'canon-ed25519-sk:';
export const PUBLIC_KEY_PREFIX = 'canon-ed25519-pk:';

export function parsePrivateKey(text) {
  if (typeof text !== 'string' || !text.startsWith(PRIVATE_KEY_PREFIX)) throw new PublicationError(CODES.INVALID, `the publisher signing key must be ${PRIVATE_KEY_PREFIX}<key>`);
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(text.slice(PRIVATE_KEY_PREFIX.length), 'base64url'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new PublicationError(CODES.INVALID, 'the publisher signing key is not a valid key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new PublicationError(CODES.INVALID, 'the publisher signing key is not an Ed25519 key');
  return key;
}

export function publicKeyText(privateKey) {
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  const text = `${PUBLIC_KEY_PREFIX}${x}`;
  if (!PUBLIC_KEY_FORMAT.test(text)) throw new Error('public key did not encode to the expected format');
  return text;
}

export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey: `${PRIVATE_KEY_PREFIX}${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')}`, publicKey: publicKeyText(privateKey) };
}

// Returns a function that gives the signature headers for one admin request. `path` is
// the path and query exactly as the transport sends it.
export function adminSigner({ targetId, privateKey, now = () => Date.now() }) {
  if (!TARGET_ID_FORMAT.test(targetId ?? '')) throw new PublicationError(CODES.INVALID, 'a public target needs a targetId');
  const key = parsePrivateKey(privateKey);
  return function signAdmin({ method, path, body = null, contentType = '' }) {
    const timestamp = Math.floor(now() / 1000);
    const bodySha256 = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
    const message = canonicalAdminMessage({ targetId, method, target: path, contentType, bodySha256, timestamp });
    return { 'x-canon-timestamp': String(timestamp), 'x-canon-signature': sign(null, Buffer.from(message), key).toString('base64url') };
  };
}
