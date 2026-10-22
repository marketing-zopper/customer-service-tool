// Proves the sync only ever adds NEW entries: runs the real ingest code against fake Webflow and
// fake Supabase REST responses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
process.env.WEBFLOW_API_TOKEN = 'wf-token';
process.env.WEBFLOW_SITE_ID = 'site1';

const { runIngest } = await import('../lib/ingest.js');

const realFetch = globalThis.fetch;
const tables = { mail_items: [], ingested_messages: [] };
let webflowSubmissions = [];
let webflowRequests = [];
let webflowPages = []; // offsets of the pages that were requested

const submission = (id, message, extra = {}) => ({
  id,
  displayName: 'Lead Generation (Contact Page)',
  publishedPath: '/contact-us',
  dateSubmitted: new Date(Date.now() - 3600_000).toISOString(),
  formResponse: {
    'First Name': 'Asha', 'Last Name': 'Rao', Organisation: 'Acme', Designation: 'NA',
    Email: `${id}@example.com`, 'Phone Number': '1', Field: message,
  },
  ...extra,
});

const COMPLAINT = (id) => submission(id, 'My AC service is pending and I want a refund, this is a complaint');
const PARTNER = (id) => submission(id, 'We want a partnership proposal and API integration with Zopper');
const JOB_SEEKER = (id) => submission(id, 'I want an internship, please find my resume');

function fakeSupabase(url, init) {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const method = init?.method || 'GET';
  const header = (name) => (init.headers?.get ? init.headers.get(name) : init.headers?.[name]) || '';
  const rows = tables[table];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (method === 'POST') {
    const incoming = [].concat(JSON.parse(init.body));
    const conflict = u.searchParams.get('on_conflict');
    for (const row of incoming) {
      const existing = conflict && rows.find((r) => r[conflict] === row[conflict]);
      if (existing) {
        if (header('Prefer').includes('merge-duplicates')) Object.assign(existing, row);
        continue; // ignore-duplicates: the existing row is left exactly as it is
      }
      rows.push({ ...row });
    }
    return new Response(null, { status: 201 });
  }

  // GET with an `in.(...)` filter, as used by the "already seen?" lookup
  const [column, filter] = [...u.searchParams].find(([, v]) => v.startsWith('in.(')) || [];
  const wanted = filter ? filter.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) : null;
  return json(wanted ? rows.filter((r) => wanted.includes(r[column])) : rows);
}

before(() => {
  globalThis.fetch = (url, init) => {
    const href = String(url);
    if (href.startsWith(process.env.SUPABASE_URL)) return Promise.resolve(fakeSupabase(href, init));
    if (href.startsWith('https://api.webflow.com')) {
      webflowRequests.push(init?.method || 'GET');
      const offset = Number(new URL(href).searchParams.get('offset') || 0);
      webflowPages.push(offset);
      const page = webflowSubmissions.slice(offset, offset + 100);
      return Promise.resolve(new Response(JSON.stringify({ formSubmissions: page, pagination: { total: webflowSubmissions.length } }), { status: 200 }));
    }
    return realFetch(url, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const reset = (subs) => {
  tables.mail_items = [];
  tables.ingested_messages = [];
  webflowSubmissions = subs;
  webflowRequests = [];
  webflowPages = [];
};
const wf = (summary) => summary.sources.webflow;

test('first sync stores real items, drops job seekers, and never writes to Webflow', async () => {
  reset([COMPLAINT('a1'), PARTNER('a2'), JOB_SEEKER('a3')]);
  const result = await runIngest();
  assert.equal(wf(result).processed, 3);
  assert.deepEqual(tables.mail_items.map((r) => r.category).sort(), ['complaint_enquiry', 'partnership']);
  assert.equal(tables.ingested_messages.length, 3); // the job seeker is remembered too
  assert.ok(webflowRequests.length > 0 && webflowRequests.every((m) => m === 'GET'));
});

test('syncing again with nothing new adds nothing and repeats nothing', async () => {
  reset([COMPLAINT('b1'), PARTNER('b2'), JOB_SEEKER('b3')]);
  await runIngest();
  const before = JSON.stringify(tables.mail_items);
  for (let i = 0; i < 3; i += 1) {
    const result = await runIngest();
    assert.equal(wf(result).found, 0);
    assert.equal(wf(result).processed, 0);
  }
  assert.equal(JSON.stringify(tables.mail_items), before);
});

test('items you deleted, archived, moved or changed never come back or get overwritten', async () => {
  reset([COMPLAINT('c1'), PARTNER('c2'), PARTNER('c3')]);
  await runIngest();
  const byId = (id) => tables.mail_items.find((r) => r.source_id === `webflow:${id}`);

  tables.mail_items = tables.mail_items.filter((r) => r.source_id !== 'webflow:c1'); // deleted from the app
  byId('c2').archived_at = '2026-10-20T00:00:00Z'; // archived
  byId('c3').category = 'complaint_enquiry'; // moved to the other tab
  byId('c3').status = 'resolved';

  const result = await runIngest();
  assert.equal(wf(result).processed, 0);
  assert.equal(byId('c1'), undefined); // stays deleted
  assert.equal(byId('c2').archived_at, '2026-10-20T00:00:00Z');
  assert.equal(byId('c3').category, 'complaint_enquiry');
  assert.equal(byId('c3').status, 'resolved');
  assert.equal(tables.mail_items.length, 2);
});

test('only genuinely new submissions are added on the next sync', async () => {
  reset([COMPLAINT('d1'), PARTNER('d2')]);
  await runIngest();
  webflowSubmissions = [COMPLAINT('d3'), COMPLAINT('d1'), PARTNER('d2')]; // d3 is the new one
  const result = await runIngest();
  assert.equal(wf(result).found, 1);
  assert.equal(wf(result).processed, 1);
  assert.deepEqual(tables.mail_items.map((r) => r.source_id).sort(), ['webflow:d1', 'webflow:d2', 'webflow:d3']);
});

test('two syncs running at the same moment (two people, or open + Sync button) never create duplicates', async () => {
  reset([COMPLAINT('e1'), PARTNER('e2')]);
  await Promise.all([runIngest(), runIngest(), runIngest()]);
  const ids = tables.mail_items.map((r) => r.source_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 2);
});

// --- quick mode: the dashboard's automatic background check -------------------------------------

const many = (count, prefix) => Array.from({ length: count }, (_, i) => COMPLAINT(`${prefix}${i}`));

test('quick sync reads a single Webflow page when nothing is new', async () => {
  reset(many(250, 'a'));
  const first = await runIngest(); // a full sweep: 3 pages, everything imported
  assert.equal(wf(first).processed, 250);
  assert.deepEqual(webflowPages, [0, 100, 200]);

  webflowPages = [];
  const quick = await runIngest({ quick: true });
  assert.equal(wf(quick).found, 0);
  assert.equal(wf(quick).processed, 0);
  assert.deepEqual(webflowPages, [0]); // one request instead of three
});

test('quick sync imports what is new, confirms with one more page, then stops', async () => {
  reset(many(250, 'b'));
  await runIngest();
  webflowSubmissions = [...many(3, 'fresh'), ...webflowSubmissions]; // newest first
  webflowPages = [];

  const quick = await runIngest({ quick: true });
  assert.equal(wf(quick).processed, 3);
  assert.equal(tables.mail_items.length, 253);
  assert.deepEqual(webflowPages, [0, 100]); // page 1 had new items; page 2 had none, so it stopped there
});

test('quick sync leaves old stragglers to the full sweep, which finds them', async () => {
  reset(many(250, 'c'));
  await runIngest();
  // one old submission was never imported (say it failed once); it sits on the last page
  const straggler = webflowSubmissions[240];
  tables.mail_items = tables.mail_items.filter((r) => r.source_id !== `webflow:${straggler.id}`);
  tables.ingested_messages = tables.ingested_messages.filter((r) => r.source_id !== `webflow:${straggler.id}`);

  assert.equal(wf(await runIngest({ quick: true })).processed, 0); // not worth reading old pages for
  assert.equal(wf(await runIngest()).processed, 1); // the daily run / Sync button catches it
  assert.equal(tables.mail_items.length, 250);
});

test('a page of other forms\' sign-ups does not hide real entries behind it, and nothing is ever written to Webflow', async () => {
  const noise = (count, tag) => Array.from({ length: count }, (_, i) => ({ ...COMPLAINT(`${tag}${i}`), displayName: 'Subscribe to Zopper' }));
  reset([...noise(100, 'n'), ...many(5, 'd')]); // the newest page is all newsletter sign-ups
  const quick = await runIngest({ quick: true });
  assert.equal(wf(quick).processed, 5); // a page with none of ours proves nothing, so it kept reading
  assert.deepEqual(webflowPages, [0, 100]);
  assert.ok(webflowRequests.every((m) => m === 'GET'));
});

test('the automatic check is bounded: it never reads more than five pages', async () => {
  reset(noiseOnly(900));
  await runIngest({ quick: true });
  assert.equal(webflowPages.length, 5);
});

function noiseOnly(count) {
  return Array.from({ length: count }, (_, i) => ({ ...COMPLAINT(`only${i}`), displayName: 'Subscribe to Zopper' }));
}
