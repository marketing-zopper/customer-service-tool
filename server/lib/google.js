import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.js';
import { db } from './supabase.js';
import { appUrl } from './config.js';

// Google sign-in runs through this project's Supabase Auth (Google provider), as a server-side PKCE flow:
// the browser is only ever redirected, and no key or token reaches frontend JavaScript.

const b64url = (buffer) => buffer.toString('base64url');

export function newPkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const callbackUrl = () => `${appUrl()}/api/auth/callback`;

/** Where to send the browser to start Google sign-in. */
export function authorizeUrl(challenge, { chooseAccount = false } = {}) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new HttpError(500, 'Server is not configured: SUPABASE_URL missing');
  const query = new URLSearchParams({
    provider: 'google',
    redirect_to: callbackUrl(),
    code_challenge: challenge,
    code_challenge_method: 's256',
    ...(chooseAccount ? { prompt: 'select_account' } : {}),
  });
  return `${base}/auth/v1/authorize?${query}`;
}

/**
 * Trades the one-time code for the signed-in user, then asks Supabase Auth again (server-to-server)
 * who that token belongs to. The email returned is the one Google itself verified; anything else throws.
 */
export async function identityFromCode(code, verifier) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const exchange = await fetch(`${base}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const session = await exchange.json().catch(() => ({}));
  if (!exchange.ok || !session.access_token) throw new HttpError(401, 'Google sign-in could not be completed');

  const { data, error } = await db().auth.getUser(session.access_token);
  if (error || !data?.user) throw new HttpError(401, 'Google sign-in could not be verified');
  const google = (data.user.identities || []).find((identity) => identity.provider === 'google');
  const email = String(google?.identity_data?.email || '').trim().toLowerCase();
  if (!google || !email || google.identity_data.email_verified !== true) {
    throw new HttpError(401, 'Your Google account email is not verified');
  }

  // We only needed to learn who this is; don't leave a second session behind in Supabase.
  db().auth.admin.signOut(session.access_token, 'global').catch(() => {});

  const profile = data.user.user_metadata || {};
  return { email, name: String(profile.full_name || profile.name || '').trim() };
}
