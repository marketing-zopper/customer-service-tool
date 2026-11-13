import { HttpError } from './http.js';
import { envInt } from './config.js';

// Zopper Marketing Studio keeps every employee in one Upstash hash, keyed by lower-case email, each
// value a JSON record: { email, name, active, roles: { 'service-triage': 'viewer'|'editor'|'admin', ... },
// permissions: { 'service-triage': boolean, ... } }. This app only ever reads it.
export const EMPLOYEES_HASH = 'zms:employees';
export const TOOL_KEY = 'service-triage';
export const TOOL_ROLES = ['viewer', 'editor', 'admin'];

// Not an assignable role and not stored in Upstash: this one address always has full access.
export const GLOBAL_SUPER_ADMIN = 'marketingext@zopper.com';

// Read-only by construction: HGET is the only command this module is able to send.
const READ_ONLY_COMMANDS = new Set(['HGET']);

async function redis(command) {
  if (!READ_ONLY_COMMANDS.has(command[0])) throw new Error(`Refusing to send ${command[0]}: this integration is read-only`);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new HttpError(503, 'Access verification is not configured');
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    console.error('[access] Upstash unreachable');
    throw new HttpError(503, 'Access verification is unavailable. Please try again in a moment');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    console.error('[access] Upstash responded', response.status);
    throw new HttpError(503, 'Access verification is unavailable. Please try again in a moment');
  }
  return data.result;
}

/**
 * The Service Triage role in an employee record, or null (= No Access) unless every check passes:
 * the record exists and is parseable, the employee is active, the tool isn't switched off for them,
 * and the role is one we know. Anything else, including a role this app has never heard of, is denied.
 */
export function toolRole(record, email) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.active !== true) return null;
  if (typeof record.email === 'string' && record.email.trim().toLowerCase() !== email) return null;
  if (record.permissions && record.permissions[TOOL_KEY] === false) return null;
  const role = record.roles?.[TOOL_KEY];
  return TOOL_ROLES.includes(role) ? role : null;
}

// A few seconds of memory, so one page of requests is one lookup. Role changes show up within that time.
const cache = new Map();
export const clearAccessCache = () => cache.clear();

/**
 * What this verified email may do in Service Triage: { role: 'viewer'|'editor'|'admin'|null, name, superAdmin }.
 * Throws HttpError(503) when Upstash can't be asked, which callers treat as "deny".
 */
export async function accessFor(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return { role: null, name: null, superAdmin: false };
  if (clean === GLOBAL_SUPER_ADMIN) return { role: 'admin', name: null, superAdmin: true };

  const ttl = envInt('ACCESS_CACHE_SECONDS', 10) * 1000;
  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  const raw = await redis(['HGET', EMPLOYEES_HASH, clean]);
  let record = null;
  if (raw) {
    try {
      record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      record = null; // an unreadable record is treated as no record
    }
  }
  const value = { role: toolRole(record, clean), name: typeof record?.name === 'string' ? record.name : null, superAdmin: false };
  cache.set(clean, { at: Date.now(), value });
  return value;
}
