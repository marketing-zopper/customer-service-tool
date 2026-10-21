import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, parseCookies } from './http.js';
import { db, unwrap } from './supabase.js';
import { env } from './config.js';

const COOKIE_NAME = 'zs_session';
const SESSION_DAYS = 30;

const sha256 = (value) => createHash('sha256').update(value).digest();

function safeEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new HttpError(500, 'Server is not configured: SESSION_SECRET missing or too short');
  }
  return secret;
}

export function checkAdminPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError(500, 'Server is not configured: ADMIN_PASSWORD missing');
  return typeof candidate === 'string' && safeEqual(candidate, expected);
}

export function constantTimeMatch(candidate, expected) {
  return typeof candidate === 'string' && typeof expected === 'string' && safeEqual(candidate, expected);
}

// ---- Admin session: signed, httpOnly cookie carrying the chosen name ----

function sign(payload) {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function sessionCookie(name) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = Buffer.from(JSON.stringify({ n: name, exp })).toString('base64url');
  return serializeCookie(`${payload}.${sign(payload)}`, SESSION_DAYS * 86_400);
}

export function clearSessionCookie() {
  return serializeCookie('', 0);
}

function serializeCookie(value, maxAgeSeconds) {
  const secure = env('NODE_ENV', '') === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  let expected;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  if (!constantTimeMatch(signature, expected)) return null;
  try {
    const { n, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof n === 'string' && exp > Date.now() ? { name: n } : null;
  } catch {
    return null;
  }
}

// ---- Magic links ----

export const hashToken = (token) => sha256(token).toString('hex');

export const newToken = () => randomBytes(32).toString('base64url');

async function findLink(token) {
  const link = unwrap(
    await db().from('magic_links').select('*').eq('token_hash', hashToken(token)).maybeSingle(),
  );
  if (!link) return null;
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) return null;
  return link;
}

/**
 * Resolves who is calling:
 *   { kind: 'admin', name }   valid session cookie (any of the five marketing members)
 *   { kind: 'link', link }    valid, unexpired magic-link token (x-magic-token header)
 *   { kind: 'invalid' }       a token was sent but is unknown or expired
 *   { kind: 'anon' }          neither
 */
export async function authenticate(req) {
  const session = readSession(req);
  if (session) return { kind: 'admin', name: session.name };

  const token = req.headers['x-magic-token'];
  if (typeof token === 'string' && token.length >= 20 && token.length <= 200) {
    const link = await findLink(token);
    return link ? { kind: 'link', link } : { kind: 'invalid' };
  }
  return { kind: 'anon' };
}

export function requireAny(auth) {
  if (auth.kind === 'admin' || auth.kind === 'link') return;
  throw new HttpError(401, auth.kind === 'invalid' ? 'This link is invalid or has expired' : 'Sign in or use a valid link');
}

export function requireAdmin(auth) {
  if (auth.kind !== 'admin') throw new HttpError(auth.kind === 'anon' ? 401 : 403, 'Marketing team access only');
}

/** Can this caller see/modify items of the given category (and, if given, this specific item)? */
export function requireItemScope(auth, category, itemId) {
  requireAny(auth);
  if (auth.kind === 'admin') return;
  const { scope, mail_item_id: scopedItem } = auth.link;
  if (scope !== category || (scopedItem && itemId && scopedItem !== itemId)) {
    throw new HttpError(403, 'This link does not give access to that item');
  }
}
