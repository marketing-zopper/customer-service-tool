// Exercises the real router against an in-memory fake of Supabase's REST API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../router.js';
import { hashToken } from '../lib/auth.js';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
process.env.ADMIN_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'x'.repeat(32);
process.env.APP_URL = 'http://app.test';
delete process.env.RESEND_API_KEY;

const realFetch = globalThis.fetch;
const ITEM_P = '11111111-1111-1111-1111-111111111111'; // partnership
const ITEM_C = '22222222-2222-2222-2222-222222222222'; // complaint
const ITEM_C2 = '33333333-3333-3333-3333-333333333333'; // another complaint
const ITEM_LEAD = '44444444-4444-4444-4444-444444444444';

const inFuture = new Date(Date.now() + 86_400_000).toISOString();
const inPast = new Date(Date.now() - 86_400_000).toISOString();

const tables = {};
function resetDb() {
  const item = (id, category, extra = {}) => ({
    id, category, status: 'in_review', subject: `Subject ${id.slice(0, 2)}`, sender_email: 's@x.com',
    sender_name: 'Sender', body_snippet: 'snippet', body_full: 'full body', received_at: '2026-01-01T00:00:00Z',
    assigned_to: null, updated_at: '2026-01-01T00:00:00Z', is_lead: false, ...extra,
  });
  tables.admin_names = [{ name: 'Arpit Jain' }, { name: 'Farman Khan' }];
  tables.mail_items = [
    item(ITEM_P, 'partnership'), item(ITEM_C, 'complaint_enquiry'), item(ITEM_C2, 'complaint_enquiry'),
    item(ITEM_LEAD, null, { is_lead: true }),
  ];
  tables.magic_links = [
    { token_hash: hashToken('item-link-token-for-complaint-1'), scope: 'complaint_enquiry', mail_item_id: ITEM_C, expires_at: inFuture },
    { token_hash: hashToken('section-link-token-partnership'), scope: 'partnership', mail_item_id: null, expires_at: inFuture },
    { token_hash: hashToken('expired-link-token-complaint-xx'), scope: 'complaint_enquiry', mail_item_id: ITEM_C, expires_at: inPast },
  ];
}

function fakeSupabase(url, init) {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const method = init?.method || 'GET';
  const wantsObject = String(init?.headers?.Accept || init?.headers?.get?.('Accept') || '').includes('vnd.pgrst.object');
  const filters = [...u.searchParams].filter(([, v]) => v.startsWith('eq.') || v === 'is.null' || v === 'not.is.null');
  const matches = (row) =>
    filters.every(([k, v]) => {
      if (v === 'is.null') return row[k] == null;
      if (v === 'not.is.null') return row[k] != null;
      return String(row[k]) === v.slice(3);
    });
  const rows = tables[table] || [];

  let result = [];
  if (method === 'POST') {
    const body = JSON.parse(init.body);
    rows.push(...(Array.isArray(body) ? body : [body]));
    return new Response(null, { status: 201 });
  }
  if (method === 'DELETE') {
    tables[table] = rows.filter((row) => !matches(row));
    return new Response(null, { status: 204 });
  }
  if (method === 'PATCH') {
    const changed = rows.filter(matches);
    for (const row of changed) Object.assign(row, JSON.parse(init.body));
    result = changed;
  } else {
    result = rows.filter(matches);
    if (u.searchParams.has('limit')) result = result.slice(0, Number(u.searchParams.get('limit')));
  }
  const payload = wantsObject ? result[0] : result;
  const status = wantsObject && !result[0] ? 406 : 200;
  return new Response(JSON.stringify(status === 406 ? { message: 'no rows' } : payload), {
    status, headers: { 'content-type': 'application/json' },
  });
}

let server;
let base;

before(async () => {
  globalThis.fetch = (url, init) => (String(url).startsWith(process.env.SUPABASE_URL) ? Promise.resolve(fakeSupabase(String(url), init)) : realFetch(url, init));
  server = createServer(handle);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

const call = async (path, { method = 'GET', body, token, cookie } = {}) => {
  const response = await realFetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'x-magic-token': token } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
};

async function adminCookie() {
  const { cookie } = await call('/api/login', { method: 'POST', body: { name: 'Arpit Jain', password: 'correct horse' } });
  return cookie.split(';')[0];
}

test('anonymous caller has no access', async () => {
  resetDb();
  assert.deepEqual((await call('/api/session')).data, { role: 'anon' });
  assert.equal((await call('/api/items?category=partnership')).status, 401);
});

test('login: wrong password, unknown name and success', async () => {
  resetDb();
  assert.equal((await call('/api/login', { method: 'POST', body: { name: 'Arpit Jain', password: 'nope' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { name: 'Nobody', password: 'correct horse' } })).status, 401);
  const ok = await call('/api/login', { method: 'POST', body: { name: 'Farman Khan', password: 'correct horse' } });
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /HttpOnly/);
  const session = await call('/api/session', { cookie: ok.cookie.split(';')[0] });
  assert.deepEqual(session.data, { role: 'admin', name: 'Farman Khan' });
});

test('tampered session cookie is rejected', async () => {
  resetDb();
  const cookie = await adminCookie();
  const [payload, sig] = cookie.split('=')[1].split('.');
  const forged = Buffer.from(JSON.stringify({ n: 'Evil', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal((await call('/api/session', { cookie: `zs_session=${forged}.${sig}` })).data.role, 'anon');
  assert.equal((await call('/api/session', { cookie: `zs_session=${payload}.${sig}` })).data.role, 'admin');
});

test('admin sees both sections, never leads', async () => {
  resetDb();
  const cookie = await adminCookie();
  const p = await call('/api/items?category=partnership', { cookie });
  const c = await call('/api/items?category=complaint_enquiry', { cookie });
  assert.deepEqual(p.data.items.map((i) => i.id), [ITEM_P]);
  assert.deepEqual(c.data.items.map((i) => i.id).sort(), [ITEM_C, ITEM_C2].sort());
  assert.equal((await call(`/api/items/${ITEM_LEAD}`, { cookie })).status, 404);
});

test('item-scoped magic link: sees only its item, only its category', async () => {
  resetDb();
  const token = 'item-link-token-for-complaint-1';
  assert.equal((await call('/api/session', { token })).data.role, 'link');
  const list = await call('/api/items?category=complaint_enquiry', { token });
  assert.deepEqual(list.data.items.map((i) => i.id), [ITEM_C]);
  assert.equal((await call('/api/items?category=partnership', { token })).status, 403);
  assert.equal((await call(`/api/items/${ITEM_C2}`, { token })).status, 403);
  assert.equal((await call(`/api/items/${ITEM_P}`, { token })).status, 403);
  assert.equal((await call(`/api/items/${ITEM_C}`, { token })).status, 200);
});

test('section-scoped magic link sees the whole section but not the other one', async () => {
  resetDb();
  const token = 'section-link-token-partnership';
  assert.equal((await call('/api/items?category=partnership', { token })).data.items.length, 1);
  assert.equal((await call('/api/items?category=complaint_enquiry', { token })).status, 403);
});

test('expired and unknown tokens are invalid', async () => {
  resetDb();
  assert.equal((await call('/api/session', { token: 'expired-link-token-complaint-xx' })).data.role, 'invalid');
  assert.equal((await call('/api/session', { token: 'totally-made-up-token-value-123' })).data.role, 'invalid');
  assert.equal((await call('/api/items?category=complaint_enquiry', { token: 'expired-link-token-complaint-xx' })).status, 401);
});

test('status updates are validated per category and scoped', async () => {
  resetDb();
  const token = 'item-link-token-for-complaint-1';
  const bad = await call(`/api/items/${ITEM_C}/status`, { method: 'PATCH', body: { status: 'accepted' }, token });
  assert.equal(bad.status, 400);
  const ok = await call(`/api/items/${ITEM_C}/status`, { method: 'PATCH', body: { status: 'resolved' }, token });
  assert.equal(ok.data.item.status, 'resolved');
  const outOfScope = await call(`/api/items/${ITEM_C2}/status`, { method: 'PATCH', body: { status: 'resolved' }, token });
  assert.equal(outOfScope.status, 403);
  assert.equal(tables.mail_items.find((i) => i.id === ITEM_C2).status, 'in_review');
});

test('escalation is admin-only, stores a hashed link, and marks complaints escalated', async () => {
  resetDb();
  const body = { itemId: ITEM_C, email: 'Boss@Zopper.com' };
  assert.equal((await call('/api/escalate', { method: 'POST', body, token: 'item-link-token-for-complaint-1' })).status, 403);
  assert.equal((await call('/api/escalate', { method: 'POST', body })).status, 401);

  const cookie = await adminCookie();
  assert.equal((await call('/api/escalate', { method: 'POST', body: { itemId: ITEM_C, email: 'not-an-email' }, cookie })).status, 400);

  const before = tables.magic_links.length;
  const done = await call('/api/escalate', { method: 'POST', body, cookie });
  assert.equal(done.status, 200);
  assert.equal(done.data.item.status, 'escalated_to_team');
  assert.equal(done.data.item.assigned_to, 'boss@zopper.com');
  assert.equal(done.data.emailSent, false); // no RESEND_API_KEY in tests -> link handed back
  assert.equal(done.data.item.assigned_email_status, 'failed'); // the card must not claim it was emailed
  assert.equal(tables.magic_links.length, before + 1);

  const stored = tables.magic_links.at(-1);
  const url = new URL(done.data.link);
  const token = url.searchParams.get('token');
  assert.equal(url.pathname, '/dashboard/complaints');
  assert.equal(stored.token_hash, hashToken(token));
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal(stored.created_by, 'Arpit Jain');
  assert.equal(stored.mail_item_id, ITEM_C);

  // The generated link actually works, and only for that item.
  assert.deepEqual((await call('/api/items?category=complaint_enquiry', { token })).data.items.map((i) => i.id), [ITEM_C]);
});

test('escalating a partnership keeps its status', async () => {
  resetDb();
  const cookie = await adminCookie();
  const done = await call('/api/escalate', { method: 'POST', body: { itemId: ITEM_P, email: 'ceo@zopper.com' }, cookie });
  assert.equal(done.data.item.status, 'in_review');
  assert.equal(done.data.item.assigned_to, 'ceo@zopper.com');
});

test('"Needs sorting": admin-only, can be sorted by admins, cannot be escalated while unsorted', async () => {
  resetDb();
  const UNSORTED = '55555555-5555-5555-5555-555555555555';
  tables.mail_items.push({ ...tables.mail_items[0], id: UNSORTED, category: 'unsorted' });
  const cookie = await adminCookie();
  const linkToken = 'item-link-token-for-complaint-1';

  assert.deepEqual((await call('/api/items?category=unsorted', { cookie })).data.items.map((i) => i.id), [UNSORTED]);
  assert.equal((await call('/api/items?category=unsorted', { token: linkToken })).status, 403);
  assert.equal((await call(`/api/items/${UNSORTED}`, { token: linkToken })).status, 403);

  const escalate = await call('/api/escalate', { method: 'POST', body: { itemId: UNSORTED, email: 'a@zopper.com' }, cookie });
  assert.equal(escalate.status, 409);

  const asLink = await call(`/api/items/${UNSORTED}/category`, { method: 'PATCH', body: { category: 'partnership' }, token: linkToken });
  assert.equal(asLink.status, 403);
  assert.equal((await call(`/api/items/${UNSORTED}/category`, { method: 'PATCH', body: { category: 'unsorted' }, cookie })).status, 400);

  const moved = await call(`/api/items/${UNSORTED}/category`, { method: 'PATCH', body: { category: 'complaint_enquiry' }, cookie });
  assert.equal(moved.data.item.category, 'complaint_enquiry');
  assert.equal(moved.data.item.status, 'in_review');
  // Already there: refused. A wrong guess can be corrected by moving it again.
  assert.equal((await call(`/api/items/${UNSORTED}/category`, { method: 'PATCH', body: { category: 'complaint_enquiry' }, cookie })).status, 409);
  const fixed = await call(`/api/items/${UNSORTED}/category`, { method: 'PATCH', body: { category: 'partnership' }, cookie });
  assert.equal(fixed.data.item.category, 'partnership');
});

test('archive: admin-only, hides from the active list, restorable, never loses the item', async () => {
  resetDb();
  const cookie = await adminCookie();
  const archive = (id, archived, opts = {}) =>
    call(`/api/items/${id}/archive`, { method: 'PATCH', body: { archived }, ...opts });
  const ids = async (query, opts) => (await call(`/api/items?category=complaint_enquiry${query}`, opts)).data.items?.map((i) => i.id);

  // not for anonymous callers or magic-link holders
  assert.equal((await archive(ITEM_C, true)).status, 401);
  assert.equal((await archive(ITEM_C, true, { token: 'item-link-token-for-complaint-1' })).status, 403);
  assert.equal((await archive(ITEM_C, 'yes', { cookie })).status, 400);

  assert.equal((await archive(ITEM_C, true, { cookie })).status, 200);
  assert.deepEqual(await ids('', { cookie }), [ITEM_C2]); // gone from the active list
  assert.deepEqual(await ids('&archived=1', { cookie }), [ITEM_C]); // present in the archive
  assert.equal(tables.mail_items.find((i) => i.id === ITEM_C).status, 'in_review'); // status untouched

  // only admins can open the archive; a link that was sent for this exact item still opens it
  assert.equal((await call('/api/items?category=partnership&archived=1', { token: 'section-link-token-partnership' })).status, 403);
  assert.deepEqual(await ids('', { token: 'item-link-token-for-complaint-1' }), [ITEM_C]);

  // archived items can't be escalated until restored
  const escalate = { method: 'POST', body: { itemId: ITEM_C, email: 'boss@zopper.com' }, cookie };
  assert.equal((await call('/api/escalate', escalate)).status, 409);

  assert.equal((await archive(ITEM_C, false, { cookie })).status, 200);
  assert.deepEqual((await ids('', { cookie })).sort(), [ITEM_C, ITEM_C2].sort());
  assert.deepEqual(await ids('&archived=1', { cookie }), []);

  // "Needs sorting" items and leads aren't archivable (they're sorted or deleted instead)
  const UNSORTED = '77777777-7777-7777-7777-777777777777';
  tables.mail_items.push({ ...tables.mail_items[0], id: UNSORTED, category: 'unsorted' });
  assert.equal((await archive(UNSORTED, true, { cookie })).status, 409);
  assert.equal((await archive(ITEM_LEAD, true, { cookie })).status, 404);
});

test('delete: admin-only, only from Needs sorting, and the sync remembers it', async () => {
  resetDb();
  const UNSORTED = '66666666-6666-6666-6666-666666666666';
  tables.mail_items.push({ ...tables.mail_items[0], id: UNSORTED, category: 'unsorted', source_id: 'webflow:abc' });
  tables.ingested_messages = [{ source_id: 'webflow:abc', outcome: 'unsorted' }];
  const cookie = await adminCookie();
  const remove = (id, opts) => call(`/api/items/${id}`, { method: 'DELETE', ...opts });

  assert.equal((await remove(UNSORTED)).status, 401); // anonymous
  assert.equal((await remove(UNSORTED, { token: 'item-link-token-for-complaint-1' })).status, 403); // magic link
  // real Partnership / Complaint items can't be deleted from the app, and leads aren't reachable
  assert.equal((await remove(ITEM_P, { cookie })).status, 409);
  assert.equal((await remove(ITEM_C, { cookie })).status, 409);
  assert.equal((await remove(ITEM_LEAD, { cookie })).status, 404);
  assert.equal(tables.mail_items.some((i) => i.id === ITEM_P), true);

  assert.equal((await remove(UNSORTED, { cookie })).status, 200);
  assert.equal(tables.mail_items.some((i) => i.id === UNSORTED), false);
  assert.equal(tables.ingested_messages[0].outcome, 'deleted'); // still "seen", so it isn't re-imported
  assert.equal((await remove(UNSORTED, { cookie })).status, 404); // already gone
});

test('ingest endpoint: needs cron secret or admin', async () => {
  resetDb();
  process.env.CRON_SECRET = 'cron-secret-value';
  assert.equal((await call('/api/ingest')).status, 401);
  assert.equal((await call('/api/ingest', { token: 'item-link-token-for-complaint-1' })).status, 403);
  delete process.env.CRON_SECRET;
});

test('Vercel-style forwarded paths reach every route (nested paths, methods, query strings)', async () => {
  resetDb();
  const cookie = await adminCookie();
  // /api/items/<id> arrives as /api?__path=items/<id> after Vercel's rewrite
  const detail = await call(`/api?__path=items/${ITEM_C}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.item.body_full, 'full body');
  // encoded slashes, as a proxy may send them
  assert.equal((await call(`/api?__path=items%2F${ITEM_C}`, { cookie })).status, 200);
  // the original query string still arrives alongside __path
  const list = await call('/api?__path=items&category=partnership', { cookie });
  assert.deepEqual(list.data.items.map((i) => i.id), [ITEM_P]);
  // methods and 3-segment paths
  const status = await call(`/api?__path=items/${ITEM_C}/status`, { method: 'PATCH', body: { status: 'resolved' }, cookie });
  assert.equal(status.data.item.status, 'resolved');
  assert.equal((await call(`/api?__path=items/${ITEM_C}/archive`, { method: 'PATCH', body: { archived: true }, cookie })).status, 200);
  assert.equal((await call(`/api?__path=items/${ITEM_P}`, { method: 'DELETE', cookie })).status, 409); // routed, then refused by rule
  // single-segment and unknown paths
  assert.equal((await call('/api?__path=session')).data.role, 'anon');
  assert.equal((await call('/api?__path=nope/deeper')).status, 404);
  assert.equal((await call('/api')).status, 404);
});

test('unknown routes and methods', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/login')).status, 405);
});
