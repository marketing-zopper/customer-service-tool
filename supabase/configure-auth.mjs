// Turns on the Google provider in this project's Supabase Auth, using the Supabase Management API.
//
//   node supabase/configure-auth.mjs            show the current Auth setup (never prints a secret)
//   node supabase/configure-auth.mjs --apply    turn Google on and allow-list this app's callback
//
// Everything comes from environment variables, so no secret is stored in the repo:
//   SUPABASE_ACCESS_TOKEN   a personal access token (supabase.com/dashboard/account/tokens)
//   SUPABASE_URL            https://<ref>.supabase.co  (the project ref is taken from it)
//   APP_URL                 the deployed app, e.g. https://zopper-service-triage.vercel.app
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET     only for --apply
// The address to register in Google Cloud is printed at the end: <SUPABASE_URL>/auth/v1/callback

const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_URL, APP_URL } = process.env;
const apply = process.argv.includes('--apply');
const ref = SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!token || !ref) {
  console.error('Set SUPABASE_ACCESS_TOKEN and SUPABASE_URL (https://<ref>.supabase.co) first.');
  process.exit(1);
}

const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const call = async (method, body) => {
  const response = await fetch(endpoint, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Supabase answered ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};

const show = (config) => {
  const providers = Object.keys(config).filter((key) => /^external_.*_enabled$/.test(key) && config[key]).map((key) => key.slice(9, -8));
  console.log('Providers switched on :', providers.join(', ') || '(none)');
  console.log('Google client id set  :', Boolean(config.external_google_client_id));
  console.log('New sign-ups allowed  :', config.disable_signup === false);
  console.log('Site URL              :', config.site_url);
  console.log('Redirect allow-list   :', config.uri_allow_list || '(empty)');
};

const current = await call('GET');
console.log('--- current ---');
show(current);

if (apply) {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret || !APP_URL) {
    console.error('\n--apply needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_URL as well.');
    process.exit(1);
  }
  const app = APP_URL.replace(/\/+$/, '');
  // Keep whatever was already allowed; just add this app's sign-in return addresses.
  const allowed = new Set(String(current.uri_allow_list || '').split(',').map((u) => u.trim()).filter(Boolean));
  for (const url of [`${app}/api/auth/callback`, 'http://localhost:5173/api/auth/callback']) allowed.add(url);
  await call('PATCH', {
    external_google_enabled: true,
    external_google_client_id: clientId,
    external_google_secret: clientSecret,
    uri_allow_list: [...allowed].join(','),
    disable_signup: false, // people are created in Supabase Auth the first time they sign in with Google
  });
  const after = await call('GET');
  console.log('\n--- after ---');
  show(after);
  console.log('Client id matches     :', after.external_google_client_id === clientId);
}

console.log(`\nIn Google Cloud (OAuth client > Authorized redirect URIs) the one address needed is:\n  ${SUPABASE_URL}/auth/v1/callback`);
