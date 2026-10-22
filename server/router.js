import { CATEGORIES, SECTION_SLUGS, STATUSES, envInt } from './lib/config.js';
import { HttpError, readJson, sendJson } from './lib/http.js';
import { db, unwrap } from './lib/supabase.js';
import {
  authenticate,
  checkAdminPassword,
  clearSessionCookie,
  constantTimeMatch,
  hashToken,
  newToken,
  requireAdmin,
  requireAny,
  requireItemScope,
  sessionCookie,
} from './lib/auth.js';
import { emailConfigured, magicLinkUrl, sendNotificationEmail } from './lib/mail.js';
import { runIngest } from './lib/ingest.js';
import { searchFilters } from './lib/search.js';

const LIST_COLUMNS =
  'id,category,status,subject,sender_email,sender_name,body_snippet,received_at,assigned_to,assigned_email_status,archived_at,updated_at';
const DETAIL_COLUMNS = `${LIST_COLUMNS},body_full`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function getItem(id, columns = LIST_COLUMNS) {
  const item = unwrap(await db().from('mail_items').select(`${columns},is_lead`).eq('id', id).maybeSingle());
  if (!item || item.is_lead) throw new HttpError(404, 'Item not found');
  return item;
}

const stripInternal = ({ is_lead, ...item }) => item;

// ---- Handlers -------------------------------------------------------------

const handlers = {
  async session({ auth }) {
    switch (auth.kind) {
      case 'admin':
        return { role: 'admin', name: auth.name };
      case 'link':
        return {
          role: 'link',
          scope: auth.link.scope,
          section: SECTION_SLUGS[auth.link.scope],
          itemId: auth.link.mail_item_id,
          expiresAt: auth.link.expires_at,
        };
      default:
        return { role: auth.kind };
    }
  },

  async adminNames() {
    const rows = unwrap(await db().from('admin_names').select('name').order('name'));
    return { names: rows.map((row) => row.name) };
  },

  async login({ req, res }) {
    const { name, password } = await readJson(req);
    const rows = unwrap(await db().from('admin_names').select('name').eq('name', String(name || '')));
    const valid = rows.length === 1 && checkAdminPassword(password);
    if (!valid) {
      await new Promise((resolve) => setTimeout(resolve, 600)); // blunt brute-force speed bump
      throw new HttpError(401, 'Wrong name or password');
    }
    res.setHeader('Set-Cookie', sessionCookie(rows[0].name));
    return { role: 'admin', name: rows[0].name };
  },

  async logout({ res }) {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return { ok: true };
  },

  async listItems({ auth, url }) {
    const category = url.searchParams.get('category');
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category');
    requireItemScope(auth, category);
    const archived = url.searchParams.get('archived') === '1';
    if (archived) requireAdmin(auth);

    let query = db()
      .from('mail_items')
      .select(LIST_COLUMNS)
      .eq('category', category)
      .eq('is_lead', false)
      .order('received_at', { ascending: false })
      .limit(300);
    if (auth.kind === 'link' && auth.link.mail_item_id) {
      // Someone sent a link to one specific item: they see it even if it has since been archived.
      query = query.eq('id', auth.link.mail_item_id);
    } else {
      query = archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
    }
    // Optional search box; every word must match (see lib/search.js).
    for (const filter of searchFilters(url.searchParams.get('q'))) query = query.or(filter);
    const items = unwrap(await query);

    if (auth.kind !== 'admin') return { items };
    const { count } = await db()
      .from('mail_items')
      .select('id', { count: 'exact', head: true })
      .eq('category', category)
      .eq('is_lead', false)
      .not('archived_at', 'is', null);
    return { items, archivedCount: count ?? 0 };
  },

  // Archive / restore: hides an item from the active list without touching its status.
  async setArchived({ req, auth, params }) {
    requireAdmin(auth);
    const { archived } = await readJson(req);
    if (typeof archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
    const item = await getItem(params.id);

    const updated = unwrap(
      await db()
        .from('mail_items')
        .update({ archived_at: archived ? new Date().toISOString() : null })
        .eq('id', item.id)
        .select(LIST_COLUMNS)
        .single(),
    );
    return { item: updated };
  },

  async getItem({ auth, params }) {
    const item = await getItem(params.id, DETAIL_COLUMNS);
    requireItemScope(auth, item.category, item.id);
    return { item: stripInternal(item) };
  },

  async updateStatus({ req, auth, params }) {
    const { status } = await readJson(req);
    const item = await getItem(params.id);
    requireItemScope(auth, item.category, item.id);
    if (!STATUSES[item.category].includes(status)) throw new HttpError(400, `Invalid status for ${item.category}`);

    const updated = unwrap(
      await db().from('mail_items').update({ status }).eq('id', item.id).select(LIST_COLUMNS).single(),
    );
    return { item: updated };
  },

  // Moves an item to the other tab (fixes a wrong guess by the rules).
  async setCategory({ req, auth, params }) {
    requireAdmin(auth);
    const { category } = await readJson(req);
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Choose Partnership or Complaint / Enquiry');
    const item = await getItem(params.id);
    if (item.category === category) throw new HttpError(409, 'This item is already there');

    const updated = unwrap(
      await db().from('mail_items').update({ category, status: 'active' }).eq('id', item.id).select(LIST_COLUMNS).single(),
    );
    return { item: updated };
  },

  // Permanently removes an unwanted item (spam, off-topic). Only from Partnership, which is where
  // anything the rules couldn't place lands; Complaints can only be archived. The sync remembers the
  // id, so a deleted item never comes back.
  async deleteItem({ auth, params }) {
    requireAdmin(auth);
    const item = await getItem(params.id, `${LIST_COLUMNS},source_id`);
    if (item.category !== 'partnership') throw new HttpError(409, 'Only Partnership items can be deleted. Archive this one instead');

    unwrap(await db().from('mail_items').delete().eq('id', item.id));
    if (item.source_id) {
      unwrap(await db().from('ingested_messages').update({ outcome: 'deleted' }).eq('source_id', item.source_id));
    }
    return { ok: true };
  },

  // "Notify": emails the concerned person a one-item magic link plus the full details of the query,
  // copying (and replying to) the employee who pressed the button.
  async escalate({ req, auth }) {
    requireAdmin(auth);
    const { itemId, email, ccEmail, note } = await readJson(req);
    const recipient = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(recipient) || recipient.length > 254) throw new HttpError(400, 'Enter a valid email address for the person to notify');
    const cc = String(ccEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(cc) || cc.length > 254) throw new HttpError(400, 'Enter your own email address. You will be copied on the notification');
    const cleanNote = String(note || '').trim().slice(0, 1000);

    const item = await getItem(itemId, DETAIL_COLUMNS);
    if (item.archived_at) throw new HttpError(409, 'Restore this item from the archive before notifying about it');
    const ttlDays = envInt('MAGIC_LINK_TTL_DAYS', 7);
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    const token = newToken();

    unwrap(
      await db().from('magic_links').insert({
        token_hash: hashToken(token),
        scope: item.category,
        mail_item_id: item.id,
        recipient_email: recipient,
        expires_at: expiresAt,
        created_by: `${auth.name} <${cc}>`,
      }),
    );

    const url = magicLinkUrl(item.category, token);
    let emailSent = false;
    let emailError = null;
    if (emailConfigured()) {
      try {
        await sendNotificationEmail({ to: recipient, cc, item, url, notifiedBy: auth.name, note: cleanNote, expiresAt });
        emailSent = true;
      } catch (error) {
        console.error('[notify] email failed:', error.message);
        emailError = `The email could not be sent. ${error.message}`;
      }
    } else {
      emailError = 'Email sending is not configured (RESEND_API_KEY).';
    }

    const updated = unwrap(
      await db()
        .from('mail_items')
        .update({ assigned_to: recipient, assigned_email_status: emailSent ? 'sent' : 'failed', status: 'notified' })
        .eq('id', item.id)
        .select(LIST_COLUMNS)
        .single(),
    );

    // The raw link is only handed back when the email did not go out, so the sender can share it by hand.
    return { item: updated, emailSent, emailError, expiresAt, ccEmail: cc, ...(emailSent ? {} : { link: url }) };
  },

  async ingest({ req, auth }) {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const cronOk = Boolean(process.env.CRON_SECRET) && constantTimeMatch(bearer, process.env.CRON_SECRET);
    if (!cronOk) requireAdmin(auth);
    return runIngest();
  },
};

// ---- Routing --------------------------------------------------------------

const routes = [
  ['GET', /^\/api\/session$/, handlers.session, { auth: 'optional' }],
  ['GET', /^\/api\/admin-names$/, handlers.adminNames, { auth: 'none' }],
  ['POST', /^\/api\/login$/, handlers.login, { auth: 'none' }],
  ['POST', /^\/api\/logout$/, handlers.logout, { auth: 'none' }],
  ['GET', /^\/api\/items$/, handlers.listItems],
  ['GET', /^\/api\/items\/(?<id>[0-9a-f-]{36})$/, handlers.getItem],
  ['DELETE', /^\/api\/items\/(?<id>[0-9a-f-]{36})$/, handlers.deleteItem],
  ['PATCH', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/archive$/, handlers.setArchived],
  ['PATCH', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/status$/, handlers.updateStatus],
  ['PATCH', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/category$/, handlers.setCategory],
  ['POST', /^\/api\/escalate$/, handlers.escalate],
  // Called by the cron scheduler (bearer CRON_SECRET) or by an admin's "Sync" button
  ['GET', /^\/api\/ingest$/, handlers.ingest, { auth: 'optional' }],
  ['POST', /^\/api\/ingest$/, handlers.ingest, { auth: 'optional' }],
];

export async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    // On Vercel every /api/... request is rewritten to the single function with the real path in
    // `__path` (a nested file route like api/[...x].js only matches one segment there). Locally the
    // URL already is the real path.
    const forwarded = url.searchParams.get('__path');
    url.searchParams.delete('__path');
    const path = (forwarded !== null ? `/api/${forwarded}` : url.pathname).replace(/\/+$/, '') || '/';

    const pathMatches = routes.filter(([, pattern]) => pattern.test(path));
    if (pathMatches.length === 0) throw new HttpError(404, 'Not found');
    const route = pathMatches.find(([method]) => method === req.method);
    if (!route) throw new HttpError(405, 'Method not allowed');

    const [, pattern, handler, options] = route;
    const params = pattern.exec(path).groups ?? {};

    // 'none': never touches credentials. 'optional': resolved, handler decides. default: must be admin or link.
    const mode = options?.auth ?? 'required';
    const auth = mode === 'none' ? { kind: 'anon' } : await authenticate(req);
    if (mode === 'required') requireAny(auth);

    sendJson(res, 200, await handler({ req, res, url, params, auth }));
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    console.error('[api]', error);
    sendJson(res, 500, { error: 'Something went wrong' });
  }
}
