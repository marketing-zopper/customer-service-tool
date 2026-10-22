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
const sentEmails = [];
function resetDb() {
  const item = (id, category, extra = {}) => ({
    id, category, status: 'active', subject: `Subject ${id.slice(0, 2)}`, sender_email: 's@x.com',
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

// LIKE pattern (with backslash escapes) -> case-insensitive regex
const likeToRegex = (pattern) => {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'is');
};
// one or=(...) parameter -> does the row match any of its ilike terms?
const matchesOr = (row, param) =>
  [...param.matchAll(/(\w+)\.ilike\."((?:[^"\\]|\\.)*)"/g)].some(([, column, quoted]) =>
    likeToRegex(quoted.replace(/\\(.)/g, '$1')).test(String(row[column] ?? '')),
  );

function fakeSupabase(url, init) {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const method = init?.method || 'GET';
  const wantsObject = String(init?.headers?.Accept || init?.headers?.get?.('Accept') || '').includes('vnd.pgrst.object');
  const filters = [...u.searchParams].filter(([, v]) => v.startsWith('eq.') || v === 'is.null' || v === 'not.is.null');
  const ors = u.searchParams.getAll('or');
  const matches = (row) =>
    ors.every((param) => matchesOr(row, param)) &&
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
  globalThis.fetch = (url, init) => {
    const href = String(url);
    if (href.startsWith(process.env.SUPABASE_URL)) return Promise.resolve(fakeSupabase(href, init));
    if (href === 'https://api.resend.com/emails') {
      sentEmails.push(JSON.parse(init.body));
      return Promise.resolve(new Response('{"id":"test"}', { status: 200 }));
    }
    return realFetch(url, init);
  };
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

test('status updates: the shared status set, validated and scoped', async () => {
  resetDb();
  const token = 'item-link-token-for-complaint-1';
  const set = (id, status, opts) => call(`/api/items/${id}/status`, { method: 'PATCH', body: { status }, ...opts });

  // the old per-tab statuses are gone
  for (const old of ['accepted', 'rejected', 'escalated_to_team', 'bogus']) assert.equal((await set(ITEM_C, old, { token })).status, 400, old);
  // all four current statuses work on both tabs
  const cookie = await adminCookie();
  for (const status of ['active', 'in_review', 'notified', 'resolved']) {
    assert.equal((await set(ITEM_C, status, { cookie })).data.item.status, status);
    assert.equal((await set(ITEM_P, status, { cookie })).data.item.status, status);
  }
  assert.equal((await set(ITEM_C, 'resolved', { token })).data.item.status, 'resolved'); // a link holder can update their item
  assert.equal((await set(ITEM_C2, 'resolved', { token })).status, 403); // but not another one
  assert.equal(tables.mail_items.find((i) => i.id === ITEM_C2).status, 'active');
});

test('notify: admin-only, needs both emails, stores a hashed link, marks the item notified', async () => {
  resetDb();
  const body = { itemId: ITEM_C, email: 'Boss@Zopper.com', ccEmail: 'Me@Zopper.com' };
  assert.equal((await call('/api/escalate', { method: 'POST', body, token: 'item-link-token-for-complaint-1' })).status, 403);
  assert.equal((await call('/api/escalate', { method: 'POST', body })).status, 401);

  const cookie = await adminCookie();
  const send = (b) => call('/api/escalate', { method: 'POST', body: b, cookie });
  assert.equal((await send({ ...body, email: 'not-an-email' })).status, 400);
  // the sender's own email is required, so they can be copied
  assert.equal((await send({ itemId: ITEM_C, email: 'boss@zopper.com' })).status, 400);
  assert.equal((await send({ ...body, ccEmail: '' })).status, 400);
  assert.equal((await send({ ...body, ccEmail: 'nope' })).status, 400);

  const before = tables.magic_links.length;
  const done = await send(body);
  assert.equal(done.status, 200);
  assert.equal(done.data.item.status, 'notified');
  assert.equal(done.data.item.assigned_to, 'boss@zopper.com');
  assert.equal(done.data.ccEmail, 'me@zopper.com');
  assert.equal(done.data.emailSent, false); // no RESEND_API_KEY here -> link handed back
  assert.equal(done.data.item.assigned_email_status, 'failed'); // the card must not claim it was emailed
  assert.equal(tables.magic_links.length, before + 1);

  const stored = tables.magic_links.at(-1);
  const url = new URL(done.data.link);
  const token = url.searchParams.get('token');
  assert.equal(url.pathname, '/dashboard/complaints');
  assert.equal(stored.token_hash, hashToken(token));
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal(stored.created_by, 'Arpit Jain <me@zopper.com>');
  assert.equal(stored.mail_item_id, ITEM_C);

  // The generated link actually works, and only for that item.
  assert.deepEqual((await call('/api/items?category=complaint_enquiry', { token })).data.items.map((i) => i.id), [ITEM_C]);
});

test('notify works the same on a partnership and sets it to notified', async () => {
  resetDb();
  const cookie = await adminCookie();
  const done = await call('/api/escalate', { method: 'POST', body: { itemId: ITEM_P, email: 'ceo@zopper.com', ccEmail: 'me@zopper.com' }, cookie });
  assert.equal(done.data.item.status, 'notified');
  assert.equal(done.data.item.assigned_to, 'ceo@zopper.com');
});

test('notify sends the full details to the recipient, copies and sets reply-to to the sender', async () => {
  resetDb();
  const item = tables.mail_items.find((i) => i.id === ITEM_C);
  item.sender_name = 'Asha Rao';
  item.sender_email = 'asha@acme.com';
  item.body_full = `${'Line one of a long complaint. '.repeat(30)}\n\nSecond paragraph <b>kept</b>.\n\nOrganisation: Acme\nDesignation: Director\nPhone: 9999900000\nSubmitted via: Lead Generation (Contact Page) (/contact-us)`;
  process.env.RESEND_API_KEY = 're_test';
  sentEmails.length = 0;
  try {
    const cookie = await adminCookie();
    const done = await call('/api/escalate', { method: 'POST', body: { itemId: ITEM_C, email: 'Boss@zopper.com', ccEmail: 'me@zopper.com', note: 'Please call today' }, cookie });
    assert.equal(done.data.emailSent, true);
    assert.equal(done.data.link, undefined); // the raw link is not returned when the email went out
    assert.equal(done.data.item.assigned_email_status, 'sent');
    assert.equal(sentEmails.length, 1);

    const mail = sentEmails[0];
    assert.deepEqual(mail.to, ['boss@zopper.com']);
    assert.deepEqual(mail.cc, ['me@zopper.com']);
    assert.equal(mail.reply_to, 'me@zopper.com');
    assert.match(mail.subject, /^\[Complaint \/ Enquiry\]/);
    for (const part of [mail.html, mail.text]) {
      assert.ok(part.includes('Second paragraph'));
      assert.ok(part.includes('Asha Rao'));
      assert.ok(part.includes('asha@acme.com'));
      assert.ok(part.includes('9999900000'));
      assert.ok(part.includes('Acme'));
      assert.ok(part.includes('Director'));
      assert.ok(part.includes('Please call today'));
      assert.ok(part.includes('/dashboard/complaints?token='));
    }
    // the whole message is there, not a preview, and it is HTML-escaped
    assert.equal((mail.text.match(/Line one of a long complaint\./g) || []).length, 30);
    assert.ok(mail.html.includes('&lt;b&gt;kept&lt;/b&gt;'));
    assert.ok(!mail.html.includes('<b>kept</b>'));
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

test('moving an item between tabs resets it to active; there is no "unsorted" tab any more', async () => {
  resetDb();
  const cookie = await adminCookie();
  const linkToken = 'item-link-token-for-complaint-1';
  const move = (id, category, opts) => call(`/api/items/${id}/category`, { method: 'PATCH', body: { category }, ...opts });

  assert.equal((await call('/api/items?category=unsorted', { cookie })).status, 400); // the Needs sorting tab is gone
  assert.equal((await move(ITEM_C, 'partnership', { token: linkToken })).status, 403); // links can't move items
  assert.equal((await move(ITEM_C, 'unsorted', { cookie })).status, 400);

  await call(`/api/items/${ITEM_C}/status`, { method: 'PATCH', body: { status: 'notified' }, cookie });
  const moved = await move(ITEM_C, 'partnership', { cookie });
  assert.equal(moved.data.item.category, 'partnership');
  assert.equal(moved.data.item.status, 'active');
  assert.equal((await move(ITEM_C, 'partnership', { cookie })).status, 409); // already there
  assert.equal((await move(ITEM_C, 'complaint_enquiry', { cookie })).data.item.category, 'complaint_enquiry');
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
  assert.equal(tables.mail_items.find((i) => i.id === ITEM_C).status, 'active'); // status untouched

  // only admins can open the archive; a link that was sent for this exact item still opens it
  assert.equal((await call('/api/items?category=partnership&archived=1', { token: 'section-link-token-partnership' })).status, 403);
  assert.deepEqual(await ids('', { token: 'item-link-token-for-complaint-1' }), [ITEM_C]);

  // archived items can't be notified about until restored
  const notify = { method: 'POST', body: { itemId: ITEM_C, email: 'boss@zopper.com', ccEmail: 'me@zopper.com' }, cookie };
  assert.equal((await call('/api/escalate', notify)).status, 409);

  assert.equal((await archive(ITEM_C, false, { cookie })).status, 200);
  assert.deepEqual((await ids('', { cookie })).sort(), [ITEM_C, ITEM_C2].sort());
  assert.deepEqual(await ids('&archived=1', { cookie }), []);

  assert.equal((await archive(ITEM_LEAD, true, { cookie })).status, 404); // leads aren't reachable
});

test('search: finds items by name, email, phone, organisation or message; every word must match', async () => {
  resetDb();
  const add = (id, extra) => tables.mail_items.push({ ...tables.mail_items[0], id, category: 'partnership', ...extra });
  const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
  const B = 'bbbbbbbb-0000-0000-0000-00000000000b';
  const C = 'cccccccc-0000-0000-0000-00000000000c';
  add(A, { subject: 'Contact form – Acme Pvt Ltd', sender_name: 'Asha Rao', sender_email: 'asha@acme.com', body_full: 'We want a tie-up.\n\nOrganisation: Acme Pvt Ltd\nDesignation: Founder\nPhone: 9890152369' });
  add(B, { subject: 'Contact form – Birla', sender_name: 'Bimal Das', sender_email: 'bimal@birla.in', body_full: 'Claim of 100% refund please, thanks (urgent), "now"\n\nPhone: 8000011111' });
  add(C, { subject: 'Contact form – Acme Traders', sender_name: 'Chitra', sender_email: 'c@traders.in', body_full: 'Hello' });
  const cookie = await adminCookie();
  const find = async (q, query = '') => {
    const r = await call(`/api/items?category=partnership${query}&q=${encodeURIComponent(q)}`, { cookie });
    assert.equal(r.status, 200, q);
    return r.data.items.map((i) => i.id).sort();
  };

  assert.deepEqual(await find('asha'), [A]); // sender name
  assert.deepEqual(await find('BIRLA.IN'), [B]); // email, any case
  assert.deepEqual(await find('9890152369'), [A]); // phone number, found in the full message
  assert.deepEqual(await find('founder'), [A]); // designation
  assert.deepEqual(await find('acme'), [A, C].sort()); // subject / organisation
  assert.deepEqual(await find('acme founder'), [A]); // every word must match
  assert.deepEqual(await find('  acme    founder  '), [A]); // spacing is ignored
  assert.deepEqual(await find('acme birla'), []); // no single item has both
  assert.deepEqual(await find('nothing like this'), []);
  assert.equal((await find('')).length, 4); // empty search = everything (3 added + the original partnership item)

  // special characters are searched literally and never break the query
  assert.deepEqual(await find('100%'), [B]); // not a wildcard: "100" must be followed by a percent sign
  assert.deepEqual(await find('10_%'), []); // underscore is not "any character"
  assert.deepEqual(await find('(urgent),'), [B]);
  assert.deepEqual(await find('"now"'), [B]);
  assert.deepEqual(await find('x,y)or(id.gt.0'), []);

  // search respects the archive view
  await call(`/api/items/${B}/archive`, { method: 'PATCH', body: { archived: true }, cookie });
  assert.deepEqual(await find('birla'), []);
  assert.deepEqual(await find('birla', '&archived=1'), [B]);
});

test('search cannot reveal items outside what the caller may see', async () => {
  resetDb();
  const cookie = await adminCookie();
  tables.mail_items.find((i) => i.id === ITEM_C).body_full = 'secret-phrase-complaint';
  tables.mail_items.find((i) => i.id === ITEM_C2).body_full = 'secret-phrase-complaint too';
  tables.mail_items.find((i) => i.id === ITEM_P).body_full = 'secret-phrase-complaint partnership';
  const linkToken = 'item-link-token-for-complaint-1'; // sent for exactly one complaint
  const q = '&q=secret-phrase';

  // a link for one item only ever finds that item, whatever it searches for
  const own = await call(`/api/items?category=complaint_enquiry${q}`, { token: linkToken });
  assert.deepEqual(own.data.items.map((i) => i.id), [ITEM_C]);
  // and can't search another category or the archive
  assert.equal((await call(`/api/items?category=partnership${q}`, { token: linkToken })).status, 403);
  assert.equal((await call(`/api/items?category=complaint_enquiry&archived=1${q}`, { token: linkToken })).status, 403);
  // leads never show up in a search
  tables.mail_items.find((i) => i.id === ITEM_LEAD).body_full = 'secret-phrase lead';
  const all = await call(`/api/items?category=partnership${q}`, { cookie });
  assert.ok(!all.data.items.some((i) => i.id === ITEM_LEAD));
  // anonymous callers get nothing
  assert.equal((await call(`/api/items?category=partnership${q}`)).status, 401);
});

test('delete: admin-only, Partnership items only, and the sync remembers it', async () => {
  resetDb();
  const SPAM = '66666666-6666-6666-6666-666666666666';
  tables.mail_items.push({ ...tables.mail_items[0], id: SPAM, category: 'partnership', source_id: 'webflow:abc' });
  tables.ingested_messages = [{ source_id: 'webflow:abc', outcome: 'partnership' }];
  const cookie = await adminCookie();
  const remove = (id, opts) => call(`/api/items/${id}`, { method: 'DELETE', ...opts });

  assert.equal((await remove(SPAM)).status, 401); // anonymous
  assert.equal((await remove(SPAM, { token: 'item-link-token-for-complaint-1' })).status, 403); // magic link
  // Complaints can only be archived, and leads aren't reachable
  assert.equal((await remove(ITEM_C, { cookie })).status, 409);
  assert.equal((await remove(ITEM_LEAD, { cookie })).status, 404);
  assert.equal(tables.mail_items.some((i) => i.id === ITEM_C), true);

  assert.equal((await remove(SPAM, { cookie })).status, 200);
  assert.equal(tables.mail_items.some((i) => i.id === SPAM), false);
  assert.equal(tables.ingested_messages[0].outcome, 'deleted'); // still "seen", so it isn't re-imported
  assert.equal((await remove(SPAM, { cookie })).status, 404); // already gone
});

test('sync endpoint: marketing team only; there is no scheduler secret any more', async () => {
  resetDb();
  const sync = (opts = {}) => call('/api/ingest', { method: 'POST', ...opts });
  assert.equal((await sync()).status, 401); // anonymous
  assert.equal((await sync({ token: 'item-link-token-for-complaint-1' })).status, 403); // magic link
  assert.equal((await call('/api/ingest')).status, 405); // GET was only for the removed daily job
  // a bearer secret no longer opens it, even if one is still set in the environment
  process.env.CRON_SECRET = 'old-secret';
  const withSecret = await realFetch(`${base}/api/ingest`, { method: 'POST', headers: { authorization: 'Bearer old-secret' } });
  assert.equal(withSecret.status, 401);
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
  assert.equal((await call(`/api?__path=items/${ITEM_C}`, { method: 'DELETE', cookie })).status, 409); // routed, then refused by rule
  // single-segment and unknown paths
  assert.equal((await call('/api?__path=session')).data.role, 'anon');
  assert.equal((await call('/api?__path=nope/deeper')).status, 404);
  assert.equal((await call('/api')).status, 404);
});

test('unknown routes and methods', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/login')).status, 405);
});
