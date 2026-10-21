import { createClient } from '@supabase/supabase-js';
import { HttpError } from './http.js';

let client;

// Service-role client. Server-side only: it bypasses RLS, so the browser never gets it.
export function db() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new HttpError(500, 'Server is not configured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    }
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

// Supabase returns { data, error } instead of throwing.
export function unwrap({ data, error }) {
  if (error) {
    console.error('[supabase]', error);
    throw new HttpError(500, 'Database error');
  }
  return data;
}
