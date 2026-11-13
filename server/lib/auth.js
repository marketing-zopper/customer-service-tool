import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, parseCookies } from './http.js';
import { db, unwrap } from './supabase.js';
import { authMode, env, envInt } from './config.js';
import { accessFor } from './employees.js';

const COOKIE_NAME = 'zs_session'; // legacy shared-password session
const USER_COOKIE = 'zs_user'; // Google session (a different name, so neither mode can read the other's cookie)
const OAUTH_COOKIE = 'zs_oauth'; // lives only while someone is at Google
const SESSION_DAYS = 30;
const OAUTH_MINUTES = 10;

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

// ---- Signed cookies. `context` keeps a signature made for one purpose from being replayed as another ----

function sign(payload, context = '') {
  return createHmac('sha256', sessionSecret()).update(context + payload).digest('base64url');
}

function serializeCookie(name, value, maxAgeSeconds) {
  const secure = env('NODE_ENV', '') === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function signedCookie(name, data, maxAgeSeconds, context) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + maxAgeSeconds * 1000 })).toString('base64url');
  return serializeCookie(name, `${payload}.${sign(payload, context)}`, maxAgeSeconds);
}

/** The data inside a signed, unexpired cookie of ours, or null. */
function readSigned(req, name, context) {
  const raw = parseCookies(req.headers.cookie)[name];
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  let expected;
  try {
    expected = sign(payload, context);
  } catch {
    return null;
  }
  if (!constantTimeMatch(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// ---- Legacy admin session: signed, httpOnly cookie carrying the chosen name ----

export function sessionCookie(name) {
  return signedCookie(COOKIE_NAME, { n: name }, SESSION_DAYS * 86_400, '');
}

export const clearSessionCookie = () => [serializeCookie(COOKIE_NAME, '', 0), serializeCookie(USER_COOKIE, '', 0)];

function readSession(req) {
  const data = readSigned(req, COOKIE_NAME, '');
  return data && typeof data.n === 'string' ? { name: data.n } : null;
}

// ---- Google session: who signed in with Google. What they may do is looked up fresh on every request ----

export function userSessionCookie(email, name) {
  return signedCookie(USER_COOKIE, { e: email, n: name }, envInt('SESSION_DAYS', 7) * 86_400, 'user.');
}

export const clearUserCookie = () => serializeCookie(USER_COOKIE, '', 0);

function readUserSession(req) {
  const data = readSigned(req, USER_COOKIE, 'user.');
  return data && typeof data.e === 'string' ? { email: data.e.toLowerCase(), name: typeof data.n === 'string' ? data.n : '' } : null;
}

// ---- The short-lived cookie that carries the PKCE secret and the page to return to while at Google ----

export const oauthCookie = (data) => signedCookie(OAUTH_COOKIE, data, OAUTH_MINUTES * 60, 'oauth.');
export const clearOauthCookie = () => serializeCookie(OAUTH_COOKIE, '', 0);
export const readOauthCookie = (req) => {
  const data = readSigned(req, OAUTH_COOKIE, 'oauth.');
  return data && typeof data.v === 'string' ? data : null;
};

// ---- Magic links (legacy mode only) ----

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
 * Resolves who is calling.
 *
 * google mode:
 *   { kind: 'user', email, name, role, superAdmin }   signed in with Google and allowed by Upstash
 *   { kind: 'denied', email }                         signed in, but no access (missing, inactive, no role)
 *   { kind: 'anon' }                                  not signed in (magic-link headers are ignored)
 *   Throws 503 if Upstash can't be asked: access is never granted on a guess.
 *
 * legacy mode:
 *   { kind: 'admin', name }   valid session cookie (any of the five marketing members)
 *   { kind: 'link', link }    valid, unexpired magic-link token (x-magic-token header)
 *   { kind: 'invalid' }       a token was sent but is unknown or expired
 *   { kind: 'anon' }          neither
 */
export async function authenticate(req) {
  if (authMode() === 'google') {
    const session = readUserSession(req);
    if (!session) return { kind: 'anon' };
    const access = await accessFor(session.email);
    if (!access.role) return { kind: 'denied', email: session.email };
    return { kind: 'user', email: session.email, name: access.name || session.name || session.email, role: access.role, superAdmin: access.superAdmin };
  }

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
  if (auth.kind === 'admin' || auth.kind === 'link' || auth.kind === 'user') return;
  if (auth.kind === 'denied') throw new HttpError(403, 'Your account does not have access to Service Triage');
  throw new HttpError(401, auth.kind === 'invalid' ? 'This link is invalid or has expired' : 'Sign in or use a valid link');
}

// ---- Permissions: the lowest role that may do each thing (Viewer < Editor < Admin) ----

const RANK = { viewer: 1, editor: 2, admin: 3 };
export const ACTIONS = {
  view: 'viewer', // see and search cases and comments, including the archive
  comment: 'editor', // add comments, delete your own
  status: 'editor', // change a case's status
  notify: 'editor', // send a notification email
  sync: 'editor', // pull new Webflow submissions
  manage: 'admin', // move between tabs, archive / restore, delete
};

/** Can this caller do `action`? (Item-level scope for link holders is checked separately, by requireItemScope.) */
export function can(auth, action) {
  switch (auth.kind) {
    case 'admin':
      return true; // legacy shared-password session: everything, as before
    case 'user':
      return RANK[auth.role] >= RANK[ACTIONS[action]];
    case 'link':
      return action === 'view' || action === 'comment' || action === 'status';
    default:
      return false;
  }
}

export const permissionsOf = (auth) => Object.fromEntries(Object.keys(ACTIONS).map((action) => [action, can(auth, action)]));

export function requirePermission(auth, action) {
  requireAny(auth);
  if (can(auth, action)) return;
  if (auth.kind === 'user') throw new HttpError(403, `Your ${auth.role} role can't do this. It needs ${ACTIONS[action]} access`);
  throw new HttpError(403, 'Marketing team access only');
}

/** Can this caller see/modify items of the given category (and, if given, this specific item)? */
export function requireItemScope(auth, category, itemId) {
  requireAny(auth);
  if (auth.kind === 'admin' || auth.kind === 'user') return;
  const { scope, mail_item_id: scopedItem } = auth.link;
  if (scope !== category || (scopedItem && itemId && scopedItem !== itemId)) {
    throw new HttpError(403, 'This link does not give access to that item');
  }
}
