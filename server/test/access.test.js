// Exercises the real router against an in-memory fake of Supabase's REST API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../router.js';
import { createHash } from 'node:crypto';
import { hashToken } from '../lib/auth.js';
import { clearAccessCache } from '../lib/employees.js';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
process.env.ADMIN_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'x'.repeat(32);
process.env.APP_URL = 'http://app.test';
process.env.UPSTASH_REDIS_REST_URL = 'http://fake-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
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
    id, comment_count: 0, category, status: 'active', subject: `Subject ${id.slice(0, 2)}`, sender_email: 's@x.com',
    sender_name: 'Sender', body_snippet: 'snippet', body_full: 'full body', received_at: '2026-01-01T00:00:00Z',
    assigned_to: null, updated_at: '2026-01-01T00:00:00Z', is_lead: false, ...extra,
  });
  tables.admin_names = [{ name: 'Arpit Jain' }, { name: 'Farman Khan' }];
  tables.mail_items = [
    item(ITEM_P, 'partnership'), item(ITEM_C, 'complaint_enquiry'), item(ITEM_C2, 'complaint_enquiry'),
    item(ITEM_LEAD, null, { is_lead: true }),
  ];
  tables.item_comments = [];
  tables.magic_links = [
    { token_hash: hashToken('item-link-token-for-complaint-1'), scope: 'complaint_enquiry', mail_item_id: ITEM_C, recipient_email: 'boss@zopper.com', expires_at: inFuture },
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
  const filters = [...u.searchParams].filter(([, v]) => v.startsWith('eq.') || v.startsWith('in.(') || v === 'is.null' || v === 'not.is.null');
  const ors = u.searchParams.getAll('or');
  const matches = (row) =>
    ors.every((param) => matchesOr(row, param)) &&
    filters.every(([k, v]) => {
      if (v === 'is.null') return row[k] == null;
      if (v === 'not.is.null') return row[k] != null;
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
      return String(row[k]) === v.slice(3);
    });
  const rows = tables[table] || [];

  let result = [];
  // the atomic reply function: add the comment and update the item together, return the comment
  if (method === 'POST' && table === 'respond_to_item') {
    const p = JSON.parse(init.body);
    const item = tables.mail_items.find((i) => i.id === p.p_item);
    const comment = {
      id: `00000000-0000-4000-9000-${String((tables.item_comments || []).length + 1).padStart(12, '0')}`,
      mail_item_id: p.p_item,
      author: p.p_author,
      author_role: p.p_role,
      body: p.p_body,
      status_set: p.p_status,
      created_at: new Date(Date.now() + (tables.item_comments || []).length).toISOString(),
    };
    tables.item_comments.push(comment);
    if (p.p_status) item.status = p.p_status;
    if (p.p_body !== null) item.comment_count += 1;
    return new Response(JSON.stringify(comment), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // the atomic delete: only the author's own text comment goes, and the count follows
  if (method === 'POST' && table === 'delete_item_comment') {
    const p = JSON.parse(init.body);
    const at = tables.item_comments.findIndex(
      (c) => c.id === p.p_comment && c.mail_item_id === p.p_item && c.author === p.p_author && c.author_role === p.p_role && c.body != null,
    );
    if (at !== -1) {
      tables.item_comments.splice(at, 1);
      const item = tables.mail_items.find((i) => i.id === p.p_item);
      item.comment_count = Math.max(item.comment_count - 1, 0);
    }
    return new Response(JSON.stringify(at !== -1), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'POST') {
    const incoming = [].concat(JSON.parse(init.body)).map((row) => ({
      id: `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`,
      created_at: new Date(Date.now() + rows.length).toISOString(),
      ...row,
    }));
    rows.push(...incoming);
    const prefer = init.headers?.get ? init.headers.get('Prefer') : init.headers?.Prefer;
    if (!String(prefer || '').includes('return=representation')) return new Response(null, { status: 201 });
    return new Response(JSON.stringify(wantsObject ? incoming[0] : incoming), { status: 201, headers: { 'content-type': 'application/json' } });
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

// ---- Upstash: the employee hash, answering HGET only, remembering every command it was sent ----
const employees = new Map();
const redisCommands = [];
let redisDown = false;
function fakeRedis(init) {
  const command = JSON.parse(init.body);
  redisCommands.push(command);
  if (redisDown) return new Response('{"error":"down"}', { status: 500 });
  if (command[0] !== 'HGET' || command[1] !== 'zms:employees') return new Response('{"error":"unexpected"}', { status: 400 });
  return new Response(JSON.stringify({ result: employees.get(command[2]) ?? null }), { status: 200 });
}
const employeeRecord = (email, role, extra = {}) =>
  JSON.stringify({ email, name: 'Test Person', active: true, rbacVersion: 2, roles: { 'service-triage': role }, permissions: { 'service-triage': true }, ...extra });
function setEmployee(email, role, extra) {
  employees.set(email, typeof role === 'string' || role === undefined ? employeeRecord(email, role, extra) : JSON.stringify(role));
  clearAccessCache();
}

// ---- Supabase Auth: Google sign-in as a PKCE flow (one-time codes, verifier checked against the challenge) ----
const googleCodes = new Map();
const googleTokens = new Map();
function fakeAuth(href, init) {
  const u = new URL(href);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/auth/v1/token') {
    const { auth_code: code, code_verifier: verifier } = JSON.parse(init.body);
    const entry = googleCodes.get(code);
    const challenge = createHash('sha256').update(String(verifier)).digest('base64url');
    if (!entry || entry.used || entry.challenge !== challenge) return json({ error: 'invalid_grant' }, 400);
    entry.used = true;
    const token = `jwt-${code}`;
    googleTokens.set(token, entry.identity);
    return json({ access_token: token, token_type: 'bearer' });
  }
  if (u.pathname === '/auth/v1/user') {
    const identity = googleTokens.get(String(init.headers.Authorization || init.headers.authorization || '').replace('Bearer ', ''));
    if (!identity) return json({ msg: 'invalid JWT' }, 401);
    return json({
      id: '00000000-0000-4000-a000-000000000001', aud: 'authenticated', email: identity.email, created_at: '2026-01-01T00:00:00Z',
      app_metadata: { provider: identity.provider ?? 'google' }, user_metadata: { full_name: identity.name },
      identities: identity.provider === 'email'
        ? [{ provider: 'email', identity_data: { email: identity.email, email_verified: true } }]
        : [{ provider: 'google', identity_data: { email: identity.email, email_verified: identity.verified } }],
    });
  }
  return new Response(null, { status: 204 }); // logout
}

let server;
let base;

before(async () => {
  globalThis.fetch = (url, init) => {
    const href = String(url);
    if (href === process.env.UPSTASH_REDIS_REST_URL) return Promise.resolve(fakeRedis(init));
    if (href.startsWith(`${process.env.SUPABASE_URL}/auth/v1/`)) return Promise.resolve(fakeAuth(href, init));
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
  assert.equal((await send({ ...body, ccEmail: 'me@zopper.com, nope' })).status, 400); // every address is checked
  assert.equal((await send({ ...body, ccEmail: Array.from({ length: 11 }, (_, i) => `p${i}@zopper.com`) })).status, 400); // up to 10

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

    // several CC addresses: separators of any kind, repeats and capitals tidied, the recipient not copied on their own mail
    sentEmails.length = 0;
    const many = await call('/api/escalate', {
      method: 'POST',
      body: { itemId: ITEM_C, email: 'boss@zopper.com', ccEmail: 'Me@zopper.com; lead@zopper.com,  ME@zopper.com\nboss@zopper.com' },
      cookie,
    });
    assert.equal(many.status, 200);
    assert.deepEqual(many.data.ccEmails, ['me@zopper.com', 'lead@zopper.com', 'boss@zopper.com']);
    assert.deepEqual(sentEmails[0].cc, ['me@zopper.com', 'lead@zopper.com']);
    assert.deepEqual(sentEmails[0].reply_to, ['me@zopper.com', 'lead@zopper.com', 'boss@zopper.com']);
    assert.equal(tables.magic_links.at(-1).created_by, 'Arpit Jain <me@zopper.com, lead@zopper.com, boss@zopper.com>');
    // an array works too
    sentEmails.length = 0;
    await call('/api/escalate', { method: 'POST', body: { itemId: ITEM_C, email: 'boss@zopper.com', ccEmail: ['me@zopper.com', 'x@zopper.com'] }, cookie });
    assert.deepEqual(sentEmails[0].cc, ['me@zopper.com', 'x@zopper.com']);
    sentEmails.length = 0;
    await call('/api/escalate', { method: 'POST', body: { itemId: ITEM_C, email: 'Boss@zopper.com', ccEmail: 'me@zopper.com', note: 'Please call today' }, cookie });
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

test('respond: the person a query was escalated to saves a status and a comment together', async () => {
  resetDb();
  const link = 'item-link-token-for-complaint-1'; // sent to boss@zopper.com for exactly one complaint
  const respond = (id, body, opts = {}) => call(`/api/items/${id}/respond`, { method: 'POST', body, ...opts });

  // who may respond
  assert.equal((await respond(ITEM_C, { comment: 'hi' })).status, 401); // anonymous
  assert.equal((await respond(ITEM_C2, { comment: 'hi' }, { token: link })).status, 403); // another item
  assert.equal((await respond(ITEM_P, { comment: 'hi' }, { token: link })).status, 403); // another tab
  assert.equal(tables.item_comments.length, 0);

  // what is refused
  assert.equal((await respond(ITEM_C, {}, { token: link })).status, 400); // nothing to save
  assert.equal((await respond(ITEM_C, { comment: '   ' }, { token: link })).status, 400); // blank
  assert.equal((await respond(ITEM_C, { status: 'active' }, { token: link })).status, 400); // same status, no comment
  assert.equal((await respond(ITEM_C, { status: 'accepted', comment: 'x' }, { token: link })).status, 400); // old status
  assert.equal((await respond(ITEM_C, { comment: 'x'.repeat(2001) }, { token: link })).status, 400); // too long
  assert.equal(tables.item_comments.length, 0);

  // status + comment in one go
  const both = await respond(ITEM_C, { status: 'resolved', comment: '  Refund issued today.  ' }, { token: link });
  assert.equal(both.status, 200);
  assert.equal(both.data.item.status, 'resolved');
  assert.equal(both.data.item.comment_count, 1);
  assert.equal(both.data.comment.author, 'boss@zopper.com');
  assert.equal(both.data.comment.author_role, 'responder');
  assert.equal(both.data.comment.body, 'Refund issued today.'); // trimmed
  assert.equal(both.data.comment.status_set, 'resolved');

  // comment alone leaves the status; status alone adds an entry but no comment
  const commentOnly = await respond(ITEM_C, { comment: 'Customer confirmed.' }, { token: link });
  assert.equal(commentOnly.data.item.status, 'resolved');
  assert.equal(commentOnly.data.item.comment_count, 2);
  assert.equal(commentOnly.data.comment.status_set, null);
  const statusOnly = await respond(ITEM_C, { status: 'in_review' }, { token: link });
  assert.equal(statusOnly.data.item.status, 'in_review');
  assert.equal(statusOnly.data.item.comment_count, 2); // only written comments are counted
  assert.equal(statusOnly.data.comment.body, null);

  // it is all stored in order, shown with the item, and counted on the list
  const detail = await call(`/api/items/${ITEM_C}`, { token: link });
  assert.deepEqual(detail.data.comments.map((c) => [c.body, c.status_set]), [
    ['Refund issued today.', 'resolved'],
    ['Customer confirmed.', null],
    [null, 'in_review'],
  ]);
  const list = await call('/api/items?category=complaint_enquiry', { token: link });
  assert.equal(list.data.items[0].comment_count, 2);
  // the list also carries the latest written comment (for the Comments column), never a status-only update
  assert.equal(list.data.items[0].latest_comment.body, 'Customer confirmed.');
  assert.equal(list.data.items[0].latest_comment.author_role, 'responder');

  // the marketing team sees the same thread, and can add to it under their own name
  const cookie = await adminCookie();
  assert.equal((await call(`/api/items/${ITEM_C}`, { cookie })).data.comments.length, 3);
  const team = await respond(ITEM_C, { comment: 'Thanks, closing this.' }, { cookie });
  assert.deepEqual([team.data.comment.author, team.data.comment.author_role], ['Arpit Jain', 'team']);
  assert.equal(team.data.item.latest_comment.body, 'Thanks, closing this.');

  // deleting: only your own comments, never someone else's, and never a status-only entry
  const remove = (itemId, commentId, opts) => call(`/api/items/${itemId}/comments/${commentId}`, { method: 'DELETE', ...opts });
  const thread = async (opts) => (await call(`/api/items/${ITEM_C}`, opts)).data.comments;
  const before = await thread({ cookie });
  const byId = (text) => before.find((c) => c.body === text);
  const mine = byId('Thanks, closing this.'); // written by Arpit Jain (team)
  const theirs = byId('Customer confirmed.'); // written by the link's recipient (responder)
  const statusEntry = before.find((c) => c.body === null);
  assert.deepEqual(before.map((c) => [c.body, c.can_delete]), [
    ['Refund issued today.', false],
    ['Customer confirmed.', false],
    [null, false],
    ['Thanks, closing this.', true],
  ]); // the team member may delete only the one they wrote
  assert.equal((await thread({ token: link })).filter((c) => c.can_delete).length, 2); // the responder: their own two, not the team's

  assert.equal((await remove(ITEM_C, mine.id)).status, 401); // anonymous
  assert.equal((await remove(ITEM_C, theirs.id, { cookie })).status, 403); // a team member can't delete the responder's
  assert.equal((await remove(ITEM_C, mine.id, { token: link })).status, 403); // the responder can't delete the team's
  const otherAdmin = (await call('/api/login', { method: 'POST', body: { name: 'Farman Khan', password: 'correct horse' } })).cookie.split(';')[0];
  assert.equal((await remove(ITEM_C, mine.id, { cookie: otherAdmin })).status, 403); // nor can another team member
  assert.equal((await remove(ITEM_C, statusEntry.id, { token: link })).status, 409); // status entries stay
  assert.equal((await remove(ITEM_C2, mine.id, { cookie })).status, 404); // right id, wrong item
  assert.equal((await remove(ITEM_C, '99999999-9999-4999-9999-999999999999', { cookie })).status, 404);
  assert.equal((await thread({ cookie })).length, 4); // none of the refusals changed anything

  const gone = await remove(ITEM_C, mine.id, { cookie });
  assert.equal(gone.status, 200);
  assert.equal(gone.data.item.comment_count, 2);
  assert.equal(gone.data.item.latest_comment.body, 'Customer confirmed.');
  assert.equal((await thread({ cookie })).length, 3);
  assert.equal((await remove(ITEM_C, mine.id, { cookie })).status, 404); // already gone
  const own = await remove(ITEM_C, theirs.id, { token: link });
  assert.equal(own.status, 200);
  assert.equal(own.data.item.comment_count, 1);

  // an item nobody has commented on has an empty thread, and markup is stored as plain text
  assert.deepEqual((await call(`/api/items/${ITEM_C2}`, { cookie })).data.comments, []);
  const raw = await respond(ITEM_C2, { comment: '<script>alert(1)</script>' }, { cookie });
  assert.equal(raw.data.comment.body, '<script>alert(1)</script>');
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

// =====================================================================================================
// Google sign-in + Upstash employee roles (AUTH_MODE=google)
// =====================================================================================================

const raw = async (path, { cookie, method = 'GET', body } = {}) => {
  const response = await realFetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, location: response.headers.get('location'), cookies: response.headers.getSetCookie() };
};
const cookieNamed = (cookies, name) => {
  const pair = cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0];
  return pair && pair !== `${name}=` ? pair : null;
};

let codeCounter = 0;
/** Goes through the whole Google round trip as the given Google account. */
async function signIn(email, { next, verified = true, provider, name = 'Test Person' } = {}) {
  const start = await raw(`/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  const oauth = cookieNamed(start.cookies, 'zs_oauth');
  const code = `code-${(codeCounter += 1)}`;
  googleCodes.set(code, { challenge: new URL(start.location).searchParams.get('code_challenge'), identity: { email, verified, name, provider }, used: false });
  const done = await raw(`/api/auth/callback?code=${code}`, { cookie: oauth });
  return { start, done, oauth, code, cookie: cookieNamed(done.cookies, 'zs_user') };
}

async function inGoogleMode(fn) {
  process.env.AUTH_MODE = 'google';
  employees.clear();
  redisDown = false;
  redisCommands.length = 0;
  clearAccessCache();
  resetDb();
  try {
    await fn();
  } finally {
    delete process.env.AUTH_MODE;
  }
}

test('google mode: signed-out callers get nothing, and the old password and magic links are refused', async () => {
  const legacyCookie = await adminCookie(); // a valid legacy session, made before switching modes
  await inGoogleMode(async () => {
    assert.deepEqual((await call('/api/session')).data, { role: 'anon', authMode: 'google' });
    assert.equal((await call('/api/items?category=partnership')).status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: { name: 'Arpit Jain', password: 'correct horse' } })).status, 410);
    assert.equal((await call('/api/admin-names')).status, 410);
    // a valid item magic link no longer opens anything, and neither does the old shared-password cookie
    assert.equal((await call(`/api/items/${ITEM_C}`, { token: 'item-link-token-for-complaint-1' })).status, 401);
    assert.equal((await call('/api/session', { cookie: legacyCookie })).data.role, 'anon');
    assert.equal((await call('/api/items?category=partnership', { cookie: legacyCookie })).status, 401);
  });
});

test('google mode: the legacy API still works exactly as before when AUTH_MODE is not google (rollback)', async () => {
  resetDb();
  assert.equal((await call('/api/auth/google')).status, 404); // the Google routes don't exist in legacy mode
  assert.equal((await call('/api/admin-names')).status, 200);
  const cookie = await adminCookie();
  assert.equal((await call('/api/items?category=partnership', { cookie })).status, 200);
  assert.equal((await call(`/api/items/${ITEM_C}`, { token: 'item-link-token-for-complaint-1' })).status, 200);
});

test('google sign-in: redirects to Supabase Auth with PKCE, then returns to the page that was asked for', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'editor');
    const start = await raw('/api/auth/google?next=%2Fdashboard%2Fcomplaints%3Fcase%3D' + ITEM_C);
    assert.equal(start.status, 302);
    const to = new URL(start.location);
    assert.equal(`${to.origin}${to.pathname}`, 'http://fake-supabase.test/auth/v1/authorize');
    assert.equal(to.searchParams.get('provider'), 'google');
    assert.equal(to.searchParams.get('redirect_to'), 'http://app.test/api/auth/callback');
    assert.equal(to.searchParams.get('code_challenge_method'), 's256');
    assert.ok(to.searchParams.get('code_challenge'));
    assert.equal(to.searchParams.get('prompt'), null); // reuse the browser's Google session silently
    assert.match(start.cookies[0], /zs_oauth=.*HttpOnly/);
    // the secret verifier never appears in the redirect
    assert.ok(!start.location.includes('code_verifier'));
    // "use a different account" asks Google for its account chooser
    assert.equal(new URL((await raw('/api/auth/google?switch=1')).location).searchParams.get('prompt'), 'select_account');

    const { done, cookie } = await signIn('a@zopper.com', { next: `/dashboard/complaints?case=${ITEM_C}` });
    assert.equal(done.status, 302);
    assert.equal(done.location, `/dashboard/complaints?case=${ITEM_C}`);
    assert.match(done.cookies.find((c) => c.startsWith('zs_user=')), /HttpOnly; SameSite=Lax/);
    assert.ok(cookie);
    assert.equal(cookieNamed(done.cookies, 'zs_oauth'), null); // the one-time secret is cleared
    const me = (await call('/api/session', { cookie })).data;
    assert.equal(me.role, 'user');
    assert.equal(me.access, 'editor');
    assert.equal(me.email, 'a@zopper.com');
    assert.equal(me.name, 'Test Person');
  });
});

test('google sign-in: the return address can only be a page of this app', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'viewer');
    for (const next of ['https://evil.example/', '//evil.example', '/api/items', '/dashboard/partnership/../../x', 'javascript:alert(1)']) {
      assert.equal((await signIn('a@zopper.com', { next })).done.location, '/dashboard/partnership', next);
    }
  });
});

test('google sign-in: no access unless Upstash says so (missing, inactive, no role, unknown role, switched off, unreadable)', async () => {
  await inGoogleMode(async () => {
    setEmployee('inactive@zopper.com', 'editor', { active: false });
    setEmployee('norole@zopper.com', { email: 'norole@zopper.com', active: true, roles: {}, permissions: {} });
    setEmployee('othertool@zopper.com', { email: 'othertool@zopper.com', active: true, roles: { 'design-request': 'admin' } });
    setEmployee('weird@zopper.com', 'superuser'); // a role this app doesn't know
    setEmployee('none@zopper.com', 'none');
    setEmployee('off@zopper.com', 'admin', { permissions: { 'service-triage': false } });
    setEmployee('stringactive@zopper.com', 'admin', { active: 'true' });
    employees.set('broken@zopper.com', '{not json');
    employees.set('array@zopper.com', '[1,2]');
    setEmployee('mismatch@zopper.com', { email: 'someone-else@zopper.com', active: true, roles: { 'service-triage': 'admin' } });
    for (const email of ['nobody@zopper.com', 'inactive', 'norole', 'othertool', 'weird', 'none', 'off', 'stringactive', 'broken', 'array', 'mismatch'].map((n) => (n.includes('@') ? n : `${n}@zopper.com`))) {
      const { done, cookie } = await signIn(email);
      assert.equal(done.location, '/dashboard/partnership?auth=denied', email);
      assert.equal(cookie, null, `${email} must not get a session`);
    }
  });
});

test('google sign-in: Google problems end without a session', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'admin');
    // the Google email isn't verified
    assert.equal((await signIn('a@zopper.com', { verified: false })).done.location, '/dashboard/partnership?auth=failed');
    // a Supabase user that did not come from Google (no Google identity) is refused
    assert.equal((await signIn('a@zopper.com', { provider: 'email' })).done.location, '/dashboard/partnership?auth=failed');
    // opened without having started here, or with the secret missing
    assert.equal((await raw('/api/auth/callback?code=whatever')).location, '/dashboard/partnership?auth=expired');
    // the user pressed Cancel at Google
    const start = await raw('/api/auth/google');
    assert.equal((await raw('/api/auth/callback?error=access_denied', { cookie: cookieNamed(start.cookies, 'zs_oauth') })).location, '/dashboard/partnership?auth=cancelled');
    // a made-up code
    assert.equal((await raw('/api/auth/callback?code=forged', { cookie: cookieNamed(start.cookies, 'zs_oauth') })).location, '/dashboard/partnership?auth=failed');
    // a code can be used once, and only by the browser that started the sign-in (PKCE)
    const good = await signIn('a@zopper.com');
    assert.ok(good.cookie);
    assert.equal((await raw(`/api/auth/callback?code=${good.code}`, { cookie: good.oauth })).location, '/dashboard/partnership?auth=failed');
    const first = await raw('/api/auth/google');
    googleCodes.set('stolen', { challenge: new URL(first.location).searchParams.get('code_challenge'), identity: { email: 'a@zopper.com', verified: true, name: 'A' }, used: false });
    const attacker = await raw('/api/auth/google'); // an attacker's own verifier does not match
    assert.equal((await raw('/api/auth/callback?code=stolen', { cookie: cookieNamed(attacker.cookies, 'zs_oauth') })).location, '/dashboard/partnership?auth=failed');
    // a tampered secret cookie
    assert.equal((await raw('/api/auth/callback?code=x', { cookie: 'zs_oauth=eyJ2IjoieCIsImV4cCI6OTk5OTk5OTk5OTk5OX0.bad' })).location, '/dashboard/partnership?auth=expired');
  });
});

test('google sign-in: if Upstash cannot be asked, nobody is let in (and nothing is granted on a guess)', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'admin');
    const { cookie } = await signIn('a@zopper.com');
    assert.ok(cookie);
    redisDown = true;
    clearAccessCache();
    const attempt = await signIn('a@zopper.com');
    assert.equal(attempt.done.location, '/dashboard/partnership?auth=unavailable');
    assert.equal(attempt.cookie, null);
    // an already signed-in person is refused too, with "try again", not let through
    const items = await call('/api/items?category=partnership', { cookie });
    assert.equal(items.status, 503);
    assert.equal((await call('/api/session', { cookie })).status, 503);
    redisDown = false;
    assert.equal((await call('/api/items?category=partnership', { cookie })).status, 200);
  });
});

test('google mode: Upstash is only ever read (HGET on the employee hash), and without its settings access is denied', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'admin');
    const { cookie } = await signIn('a@zopper.com');
    await call('/api/items?category=partnership', { cookie });
    clearAccessCache();
    await signIn('nobody@zopper.com');
    assert.ok(redisCommands.length >= 2);
    assert.ok(redisCommands.every((c) => c[0] === 'HGET' && c[1] === 'zms:employees'), JSON.stringify(redisCommands));
    assert.ok(redisCommands.every((c) => c[2] === c[2].toLowerCase()));

    const url = process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    clearAccessCache();
    try {
      assert.equal((await call('/api/items?category=partnership', { cookie })).status, 503);
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = url;
    }
  });
});

// What each role may do. [list, read, archive view, comment, status, notify, sync, move, archive, delete]
async function whatCanTheyDo(cookie) {
  const status = async (path, options = {}) => (await call(path, { ...options, cookie })).status;
  return [
    await status('/api/items?category=complaint_enquiry'),
    await status(`/api/items/${ITEM_C}`),
    await status('/api/items?category=complaint_enquiry&archived=1'),
    await status(`/api/items/${ITEM_C}/respond`, { method: 'POST', body: { comment: 'a note' } }),
    await status(`/api/items/${ITEM_C2}/status`, { method: 'PATCH', body: { status: 'in_review' } }),
    await status('/api/escalate', { method: 'POST', body: { itemId: ITEM_C2, email: 'boss@zopper.com', ccEmail: 'me@zopper.com' } }),
    await status('/api/ingest', { method: 'POST' }),
    await status(`/api/items/${ITEM_C2}/category`, { method: 'PATCH', body: { category: 'partnership' } }),
    await status(`/api/items/${ITEM_C2}/archive`, { method: 'PATCH', body: { archived: true } }),
    await status(`/api/items/${ITEM_P}`, { method: 'DELETE' }),
  ];
}

test('roles: Viewer, Editor, Admin and the Global Super Admin each get exactly their permissions from the API', async () => {
  await inGoogleMode(async () => {
    const rows = {
      viewer: [200, 200, 200, 403, 403, 403, 403, 403, 403, 403],
      editor: [200, 200, 200, 200, 200, 200, 200, 403, 403, 403],
      admin: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
      superadmin: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
    };
    for (const [role, expected] of Object.entries(rows)) {
      resetDb();
      const email = role === 'superadmin' ? 'marketingext@zopper.com' : `${role}@zopper.com`;
      if (role !== 'superadmin') setEmployee(email, role); // the Super Admin has no Upstash record at all
      const { cookie } = await signIn(email);
      assert.ok(cookie, role);
      assert.deepEqual(await whatCanTheyDo(cookie), expected, role);
    }
  });
});

test('roles: the session tells the screen what to show, and the Super Admin is only that one address', async () => {
  await inGoogleMode(async () => {
    setEmployee('viewer@zopper.com', 'viewer');
    setEmployee('Marketingext@zopper.com'.toLowerCase(), 'viewer'); // a Redis record never lowers the Super Admin
    const viewer = (await call('/api/session', { cookie: (await signIn('viewer@zopper.com')).cookie })).data;
    assert.deepEqual(viewer.can, { view: true, comment: false, status: false, notify: false, sync: false, manage: false });
    assert.equal(viewer.superAdmin, false);
    const boss = (await call('/api/session', { cookie: (await signIn('marketingext@zopper.com')).cookie })).data;
    assert.equal(boss.superAdmin, true);
    assert.ok(Object.values(boss.can).every(Boolean));
    // an "admin" role in Upstash is just Admin, not the Super Admin
    setEmployee('admin@zopper.com', 'admin');
    assert.equal((await call('/api/session', { cookie: (await signIn('admin@zopper.com')).cookie })).data.superAdmin, false);
  });
});

test('permission changes in Upstash apply to people who are already signed in', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'admin');
    const { cookie } = await signIn('a@zopper.com');
    const comment = () => call(`/api/items/${ITEM_C}/respond`, { method: 'POST', body: { comment: 'x' }, cookie });
    assert.equal((await comment()).status, 200);
    assert.equal((await call(`/api/items/${ITEM_P}/archive`, { method: 'PATCH', body: { archived: true }, cookie })).status, 200);

    setEmployee('a@zopper.com', 'viewer'); // demoted
    assert.equal((await comment()).status, 403);
    assert.equal((await call(`/api/items/${ITEM_P}/archive`, { method: 'PATCH', body: { archived: false }, cookie })).status, 403);
    assert.equal((await call('/api/items?category=partnership', { cookie })).status, 200);
    assert.equal((await call('/api/session', { cookie })).data.access, 'viewer');

    setEmployee('a@zopper.com', 'editor', { active: false }); // deactivated
    assert.equal((await call('/api/items?category=partnership', { cookie })).status, 403);
    assert.deepEqual((await call('/api/session', { cookie })).data, { role: 'denied', authMode: 'google', email: 'a@zopper.com' });

    employees.delete('a@zopper.com'); // removed
    clearAccessCache();
    assert.equal((await call('/api/items?category=partnership', { cookie })).status, 403);

    setEmployee('a@zopper.com', 'admin'); // restored
    assert.equal((await comment()).status, 200);
  });
});

test('roles: a Viewer cannot get around the screen by calling the API directly', async () => {
  await inGoogleMode(async () => {
    setEmployee('v@zopper.com', 'viewer');
    const { cookie } = await signIn('v@zopper.com');
    sentEmails.length = 0;
    const refused = async (path, options) => {
      const response = await call(path, { ...options, cookie });
      assert.equal(response.status, 403, path);
      assert.match(response.data.error, /viewer role/);
    };
    await refused(`/api/items/${ITEM_C}/respond`, { method: 'POST', body: { status: 'resolved' } });
    await refused(`/api/items/${ITEM_C}/respond`, { method: 'POST', body: { comment: 'hi', status: 'resolved' } });
    await refused(`/api/items/${ITEM_C}/status`, { method: 'PATCH', body: { status: 'resolved' } });
    await refused(`/api/items/${ITEM_P}`, { method: 'DELETE' });
    assert.equal(tables.mail_items.find((i) => i.id === ITEM_C).status, 'active');
    assert.equal(tables.item_comments.length, 0);
    assert.ok(tables.mail_items.some((i) => i.id === ITEM_P));
    assert.equal(sentEmails.length, 0);
  });
});

test('comments: written as the verified person, shown by name, deletable only by that same email', async () => {
  await inGoogleMode(async () => {
    setEmployee('first@zopper.com', 'editor', { name: 'Sam Lee' });
    setEmployee('second@zopper.com', 'editor', { name: 'Sam Lee' }); // same display name, different person
    setEmployee('viewer@zopper.com', 'viewer');
    const first = (await signIn('first@zopper.com')).cookie;
    const second = (await signIn('second@zopper.com')).cookie;
    const viewer = (await signIn('viewer@zopper.com')).cookie;

    const added = await call(`/api/items/${ITEM_C}/respond`, { method: 'POST', body: { comment: 'Called the customer' }, cookie: first });
    assert.equal(added.data.comment.author, 'Sam Lee'); // no email on screen
    assert.equal(tables.item_comments[0].author, 'Sam Lee <first@zopper.com>'); // but stored against the email
    assert.equal(tables.item_comments[0].author_role, 'team');
    assert.equal(added.data.item.latest_comment.author, 'Sam Lee');
    const id = added.data.comment.id;

    const read = (cookie) => call(`/api/items/${ITEM_C}`, { cookie });
    assert.equal((await read(first)).data.comments[0].can_delete, true);
    assert.equal((await read(second)).data.comments[0].can_delete, false);
    assert.equal((await read(viewer)).data.comments[0].can_delete, false);
    assert.equal((await read(viewer)).data.comments[0].body, 'Called the customer'); // viewers can read comments

    assert.equal((await call(`/api/items/${ITEM_C}/comments/${id}`, { method: 'DELETE', cookie: second })).status, 403);
    assert.equal((await call(`/api/items/${ITEM_C}/comments/${id}`, { method: 'DELETE', cookie: viewer })).status, 403);
    assert.equal(tables.item_comments.length, 1);
    const removed = await call(`/api/items/${ITEM_C}/comments/${id}`, { method: 'DELETE', cookie: first });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.item.latest_comment, null);
    assert.equal(tables.item_comments.length, 0);
  });
});

test('notify in google mode: the email links to the case but grants nothing, and the sender learns if the recipient has no access', async () => {
  await inGoogleMode(async () => {
    process.env.RESEND_API_KEY = 'test-key';
    try {
      setEmployee('editor@zopper.com', 'editor');
      setEmployee('boss@zopper.com', 'viewer');
      const { cookie } = await signIn('editor@zopper.com');
      sentEmails.length = 0;
      const linksBefore = tables.magic_links.length;

      const known = await call('/api/escalate', { method: 'POST', cookie, body: { itemId: ITEM_C, email: 'boss@zopper.com', ccEmail: 'editor@zopper.com', note: 'Please look' } });
      assert.equal(known.status, 200);
      assert.equal(known.data.emailSent, true);
      assert.equal(known.data.recipientAccess, 'viewer');
      assert.equal(known.data.expiresAt, null);
      assert.equal(tables.magic_links.length, linksBefore, 'no magic link is created');
      assert.equal(sentEmails.length, 1);
      const mail = sentEmails[0];
      const url = `http://app.test/dashboard/complaints?case=${ITEM_C}`;
      assert.ok(mail.html.includes(url) && mail.text.includes(url));
      assert.ok(!/token=/.test(mail.html + mail.text), 'the link carries no credential');
      assert.match(mail.text, /review the item on dashboard via the provided link above/);
      assert.ok(!/Please don't forward/.test(mail.html));
      assert.ok(!mail.html.includes('Request Access'), 'someone who already has a role is not offered "Request Access"');

      const unknown = await call('/api/escalate', { method: 'POST', cookie, body: { itemId: ITEM_C2, email: 'outsider@example.com', ccEmail: 'editor@zopper.com' } });
      assert.equal(unknown.data.recipientAccess, 'none');
      assert.equal(unknown.data.emailSent, true);
      assert.ok(sentEmails.at(-1).html.includes('Request Access'), 'someone with no role is offered "Request Access"');

      // opening that link without signing in shows nothing; signing in opens exactly that case
      assert.equal((await call(`/api/items?category=complaint_enquiry&id=${ITEM_C}`)).status, 401);
      const case1 = await call(`/api/items?category=complaint_enquiry&id=${ITEM_C}`, { cookie });
      assert.deepEqual(case1.data.items.map((i) => i.id), [ITEM_C]);
      // ...even if the case has since moved to the other tab, or been archived
      assert.deepEqual((await call(`/api/items?category=partnership&id=${ITEM_C}`, { cookie })).data.items.map((i) => i.id), [ITEM_C]);
      tables.mail_items.find((i) => i.id === ITEM_C).archived_at = '2026-02-01T00:00:00Z';
      assert.deepEqual((await call(`/api/items?category=complaint_enquiry&id=${ITEM_C}`, { cookie })).data.items.map((i) => i.id), [ITEM_C]);
      assert.equal((await call('/api/items?category=complaint_enquiry&id=not-a-uuid', { cookie })).status, 400);
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });
});

test('google mode: sign out clears the session, and one mode never accepts the other mode\'s cookie', async () => {
  await inGoogleMode(async () => {
    setEmployee('a@zopper.com', 'admin');
    const { cookie } = await signIn('a@zopper.com');
    const out = await raw('/api/logout', { method: 'POST', cookie });
    assert.ok(out.cookies.some((c) => c.startsWith('zs_user=;') && /Max-Age=0/.test(c)));
    assert.equal((await call('/api/items?category=partnership', { cookie })).status, 200); // the cookie itself is only cleared in the browser
    // rolling back to the old sign-in: a Google session is not a legacy session
    delete process.env.AUTH_MODE;
    assert.equal((await call('/api/session', { cookie })).data.role, 'anon');
    assert.equal((await call('/api/items?category=partnership', { cookie })).status, 401);
    process.env.AUTH_MODE = 'google';
  });
});
