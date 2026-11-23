// Machine-level operator profile ($CANON_HOME/profile.json or ~/.canon/profile.json).
// Clean cut from Folio/RPK: $FOLIO_HOME, $RPK_HOME and ~/.folio are not read.
//
// Authority contract: this file is read-only for the `canon` CLI and coding agents.
// Exposure policy (`tailscale` | `local` | `stopped`) and server lifecycle are owned
// exclusively by the operator (or CanonBar.app).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyAddress } from './server/bind.mjs';

export const PROFILE_SCHEMA = 'profile/v1';
export const EXPOSURES = ['tailscale', 'local', 'stopped'];
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class ProfileError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ProfileError';
    this.code = code;
  }
}

export function defaultHomeDir(env = process.env) {
  return resolve(env.CANON_HOME || join(homedir(), '.canon'));
}

export function profileFilePath(homeDir = defaultHomeDir()) {
  return join(resolve(homeDir), 'profile.json');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateProfile(raw, sourcePath = 'profile.json') {
  if (!isPlainObject(raw)) throw new ProfileError('profile-invalid', `${sourcePath}: expected JSON object`);
  const allowed = new Set(['schema', 'exposure', 'port', 'storeRoot', 'stateDir', 'buildsDir', 'tailscale']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ProfileError('profile-invalid', `${sourcePath}: unknown member "${key}"`);
  }
  if (raw.schema !== PROFILE_SCHEMA) {
    throw new ProfileError('profile-invalid', `${sourcePath}: schema must be "${PROFILE_SCHEMA}"`);
  }
  if (!EXPOSURES.includes(raw.exposure)) {
    throw new ProfileError('profile-invalid', `${sourcePath}: exposure must be one of ${EXPOSURES.join(', ')}`);
  }
  if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
    throw new ProfileError('profile-invalid', `${sourcePath}: port must be an integer 1..65535`);
  }
  for (const field of ['storeRoot', 'stateDir', 'buildsDir']) {
    if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
      throw new ProfileError('profile-invalid', `${sourcePath}: ${field} must be a non-empty path string`);
    }
  }
  let tailscale = null;
  if (raw.tailscale !== undefined && raw.tailscale !== null) {
    if (!isPlainObject(raw.tailscale)) throw new ProfileError('profile-invalid', `${sourcePath}: tailscale must be an object`);
    for (const k of Object.keys(raw.tailscale)) {
      if (k !== 'address' && k !== 'name') throw new ProfileError('profile-invalid', `${sourcePath}: unknown tailscale member "${k}"`);
    }
    const address = String(raw.tailscale.address ?? '');
    const name = String(raw.tailscale.name ?? '').toLowerCase().replace(/\.$/, '');
    if (classifyAddress(address) !== 'cgnat') {
      throw new ProfileError('profile-invalid', `${sourcePath}: tailscale.address "${address}" is not a 100.64.0.0/10 Tailscale IPv4`);
    }
    if (!HOSTNAME.test(name) || name === 'localhost') {
      throw new ProfileError('profile-invalid', `${sourcePath}: tailscale.name "${raw.tailscale.name}" is not a valid hostname`);
    }
    tailscale = { address, name };
  }
  if (raw.exposure === 'tailscale' && !tailscale) {
    throw new ProfileError('profile-invalid', `${sourcePath}: exposure "tailscale" requires tailscale { address, name }`);
  }
  return {
    schema: PROFILE_SCHEMA,
    exposure: raw.exposure,
    port: raw.port,
    storeRoot: resolve(raw.storeRoot),
    stateDir: resolve(raw.stateDir),
    buildsDir: resolve(raw.buildsDir),
    tailscale,
  };
}

export async function loadProfile(homeDir = defaultHomeDir()) {
  const path = profileFilePath(homeDir);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileError('profile-corrupt', `${path} is not valid JSON (${err.message})`);
  }
  const validated = validateProfile(parsed, path);
  return { ...validated, path };
}

function isDnsHostname(urlHost) {
  return Boolean(urlHost) && !urlHost.startsWith('[') && !/^\d+(?:\.\d+){3}$/.test(urlHost);
}

export function activeVisibilityFromService(st) {
  if (!st || st.state !== 'running') return null;
  const rawUrl = st.url ?? st.urls?.[0];
  if (!rawUrl) return null;
  try {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
    const kind = classifyAddress(host);
    if (kind === 'loopback') return 'local';
    if (kind === 'cgnat') return 'tailscale';
    if (kind === 'private') return 'lan';
    return null;
  } catch {
    return null;
  }
}

export function preferredBaseUrlFromService(st) {
  if (!st || st.state !== 'running') return null;
  const urls = st.urls ?? st.recorded?.urls ?? (st.url ? [st.url] : []);
  const named = urls.find((u) => {
    try {
      return isDnsHostname(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  return named ?? urls[0] ?? null;
}
