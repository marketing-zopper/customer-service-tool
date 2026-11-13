import { CATEGORIES, SECTION_SLUGS, STATUSES, appUrl, authMode, envInt } from './lib/config.js';
import { HttpError, readJson, redirect, sendJson } from './lib/http.js';
import { db, unwrap } from './lib/supabase.js';
import {
  authenticate,
  checkAdminPassword,
  clearOauthCookie,
  clearSessionCookie,
  can,
  clearUserCookie,
  hashToken,
  newToken,
  oauthCookie,
  permissionsOf,
  readOauthCookie,
  requireAny,
  requireItemScope,
  requirePermission,
  sessionCookie,
  userSessionCookie,
} from './lib/auth.js';
import { accessFor } from './lib/employees.js';
import { authorizeUrl, identityFromCode, newPkce } from './lib/google.js';
import { emailConfigured, magicLinkUrl, sendNotificationEmail } from './lib/mail.js';
import { runIngest } from './lib/ingest.js';
import { searchFilters } from './lib/search.js';

const LIST_COLUMNS =
  'id,category,status,subject,sender_email,sender_name,body_snippet,received_at,assigned_to,assigned_email_status,archived_at,comment_count,updated_at';
const DETAIL_COLUMNS = `${LIST_COLUMNS},body_full`;
const COMMENT_COLUMNS = 'id,author,author_role,body,status_set,created_at';
const COMMENT_MAX = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CC_MAX = 10;

/** One address, several separated by commas, semicolons or spaces, or a list: cleaned, lower-cased, no repeats. */
function parseEmails(value) {
  const parts = [].concat(value ?? []).flatMap((entry) => String(entry).split(/[\s,;]+/));
  return [...new Set(parts.map((part) => part.trim().toLowerCase()).filter(Boolean))];
}

async function getItem(id, columns = LIST_COLUMNS) {
  const item = unwrap(await db().from('mail_items').select(`${columns},is_lead`).eq('id', id).maybeSingle());
  if (!item || item.is_lead) throw new HttpError(404, 'Item not found');
  return item;
}

const stripInternal = ({ is_lead, ...item }) => item;

/**
 * Who this request writes comments as. A Google user is stored as "Name <email>" so that "delete your own
 * comment" is tied to the verified email, not just a name two people could share. A legacy team member
 * is their chosen name; a magic-link holder is the email the link was sent to.
 */
const commenter = (auth) => {
  if (auth.kind === 'user') return { author: `${auth.name} <${auth.email}>`, role: 'team' };
  if (auth.kind === 'admin') return { author: auth.name, role: 'team' };
  return { author: auth.link.recipient_email || 'Responder', role: 'responder' };
};

/** What the screen shows as the author: the stored "Name <email>" without the email part. */
const displayAuthor = (author) => String(author).replace(/\s*<[^<>]*>$/, '');

/** A comment can be deleted only by the person who wrote it, and only if it has text (status-only entries are a record). */
const isOwnComment = (comment, auth) => {
  const me = commenter(auth);
  return comment.body != null && comment.author === me.author && comment.author_role === me.role;
};

/**
 * Adds `latest_comment` (who, when, what) to each item that has a written comment, for the
 * Comments column. Ids go to the database in small groups so the request address stays short.
 */
async function withLatestComments(items) {
  const wanted = items.filter((item) => item.comment_count > 0).map((item) => item.id);
  const latest = new Map();
  for (let start = 0; start < wanted.length; start += 50) {
    const rows = unwrap(
      await db()
        .from('item_comments')
        .select('mail_item_id,author,author_role,body,created_at')
        .in('mail_item_id', wanted.slice(start, start + 50))
        .not('body', 'is', null),
    );
    for (const row of rows) {
      const seen = latest.get(row.mail_item_id);
      if (!seen || row.created_at > seen.created_at) latest.set(row.mail_item_id, row);
    }
  }
  // null (not missing) when there is none, so a client merging this over an older copy clears a deleted comment
  return items.map((item) => {
    const row = latest.get(item.id);
    return { ...item, latest_comment: row ? { author: displayAuthor(row.author), author_role: row.author_role, body: row.body, created_at: row.created_at } : null };
  });
}

const UUID_RE = /^[0-9a-f-]{36}$/;

/** A link to a case that grants nothing by itself: the reader still has to sign in. */
const caseLinkUrl = (item) => `${appUrl()}/dashboard/${SECTION_SLUGS[item.category]}?case=${item.id}`;

// After Google sign-in we return to a page of this app, never to an address someone slipped into the link.
const NEXT_RE = /^\/dashboard\/(partnership|complaints)(\?[A-Za-z0-9=&_%.-]*)?$/;
const safeNext = (value) => (typeof value === 'string' && NEXT_RE.test(value) ? value : '/dashboard/partnership');

const legacyOnly = () => {
  if (authMode() === 'google') throw new HttpError(410, 'Password sign-in is turned off. Sign in with Google');
};
const googleOnly = () => {
  if (authMode() !== 'google') throw new HttpError(404, 'Not found');
};

// ---- Handlers -------------------------------------------------------------

const handlers = {
  async session({ auth }) {
    switch (auth.kind) {
      case 'user':
        return { role: 'user', authMode: 'google', name: auth.name, email: auth.email, access: auth.role, superAdmin: auth.superAdmin, can: permissionsOf(auth) };
      case 'denied':
        return { role: 'denied', authMode: 'google', email: auth.email };
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
        return authMode() === 'google' ? { role: auth.kind, authMode: 'google' } : { role: auth.kind };
    }
  },

  async adminNames() {
    legacyOnly();
    const rows = unwrap(await db().from('admin_names').select('name').order('name'));
    return { names: rows.map((row) => row.name) };
  },

  async login({ req, res }) {
    legacyOnly();
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

  // ---- Google sign-in (AUTH_MODE=google) ----

  // Step 1: send the browser to Google (through Supabase Auth). If they already have a Google session
  // in this browser, Google bounces straight back without asking for anything.
  async authStart({ res, url }) {
    googleOnly();
    const { verifier, challenge } = newPkce();
    res.setHeader('Set-Cookie', oauthCookie({ v: verifier, next: safeNext(url.searchParams.get('next')) }));
    redirect(res, authorizeUrl(challenge, { chooseAccount: url.searchParams.get('switch') === '1' }));
  },

  // Step 2: Google sent them back with a one-time code. Verify who they are, ask Upstash what they may
  // do, and only then give them a session. Anyone not allowed gets no session at all.
  async authCallback({ req, res, url }) {
    googleOnly();
    const stash = readOauthCookie(req);
    const leave = (to, cookies = []) => {
      res.setHeader('Set-Cookie', [clearOauthCookie(), ...cookies]);
      redirect(res, to);
    };
    const back = (reason) => leave(`/dashboard/partnership?auth=${reason}`, [clearUserCookie()]);

    const code = url.searchParams.get('code');
    if (!stash) return back('expired');
    if (url.searchParams.get('error')) return back('cancelled');
    if (!code) return back('failed');

    let identity;
    try {
      identity = await identityFromCode(code, stash.v);
    } catch (error) {
      console.error('[auth] google sign-in failed:', error.message);
      return back('failed');
    }
    let access;
    try {
      access = await accessFor(identity.email);
    } catch {
      return back('unavailable'); // couldn't ask Upstash: no access on a guess
    }
    if (!access.role) return back('denied');
    leave(stash.next, [userSessionCookie(identity.email, access.name || identity.name)]);
  },

  async listItems({ auth, url }) {
    const category = url.searchParams.get('category');
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category');
    requireItemScope(auth, category);
    requirePermission(auth, 'view');
    const archived = url.searchParams.get('archived') === '1';
    if (archived && auth.kind === 'link') requirePermission(auth, 'manage'); // legacy link holders never see the archive; any signed-in role does
    const caseId = url.searchParams.get('id'); // an email link to one case: just that case, wherever it is now
    if (caseId !== null && !UUID_RE.test(caseId)) throw new HttpError(400, 'Unknown case');

    let query = db()
      .from('mail_items')
      .select(LIST_COLUMNS)
      .eq('is_lead', false)
      .order('received_at', { ascending: false })
      .limit(300);
    if (!caseId || auth.kind === 'link') query = query.eq('category', category);
    if (auth.kind === 'link' && auth.link.mail_item_id) {
      // Someone sent a link to one specific item: they see it even if it has since been archived.
      query = query.eq('id', auth.link.mail_item_id);
    } else if (caseId) {
      query = query.eq('id', caseId);
    } else {
      query = archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
    }
    // Optional search box; every word must match (see lib/search.js).
    for (const filter of searchFilters(url.searchParams.get('q'))) query = query.or(filter);
    const items = await withLatestComments(unwrap(await query));

    if (auth.kind === 'link') return { items };
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
    requirePermission(auth, 'manage');
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
    requirePermission(auth, 'view');
    const comments = unwrap(
      await db().from('item_comments').select(COMMENT_COLUMNS).eq('mail_item_id', item.id).order('created_at', { ascending: true }),
    );
    return { item: stripInternal(item), comments: comments.map((comment) => ({ ...comment, can_delete: can(auth, 'comment') && isOwnComment(comment, auth), author: displayAuthor(comment.author) })) };
  },

  // Remove one of your own comments (not someone else's, and not a status-only entry).
  async deleteComment({ auth, params }) {
    const item = await getItem(params.id);
    requireItemScope(auth, item.category, item.id);
    requirePermission(auth, 'comment');
    const comment = unwrap(
      await db().from('item_comments').select(COMMENT_COLUMNS).eq('id', params.commentId).eq('mail_item_id', item.id).maybeSingle(),
    );
    if (!comment) throw new HttpError(404, 'Comment not found');
    if (comment.body == null) throw new HttpError(409, "Status updates can't be deleted");
    if (!isOwnComment(comment, auth)) throw new HttpError(403, 'You can only delete your own comments');

    const me = commenter(auth);
    const removed = unwrap(
      await db().rpc('delete_item_comment', { p_item: item.id, p_comment: comment.id, p_author: me.author, p_role: me.role }),
    );
    if (!removed) throw new HttpError(404, 'Comment not found');
    const updated = unwrap(await db().from('mail_items').select(LIST_COLUMNS).eq('id', item.id).single());
    const [withComment] = await withLatestComments([updated]);
    return { item: withComment };
  },

  // The reply from whoever a query was escalated to: a new status, a comment, or both in one go, so
  // the comment is stored together with the status update. Allowed on exactly the items the caller
  // can already see (a shared link: its one item).
  async respond({ req, auth, params }) {
    const { status, comment } = await readJson(req);
    const item = await getItem(params.id);
    requireItemScope(auth, item.category, item.id);

    const text = String(comment ?? '').trim();
    if (text) requirePermission(auth, 'comment');
    if (status && status !== item.status) requirePermission(auth, 'status');
    if (text.length > COMMENT_MAX) throw new HttpError(400, `Comments can be up to ${COMMENT_MAX} characters`);
    if (status && !STATUSES[item.category].includes(status)) throw new HttpError(400, `Invalid status for ${item.category}`);
    const statusChanged = Boolean(status) && status !== item.status;
    if (!statusChanged && !text) throw new HttpError(400, 'Write a comment or choose a new status');

    // One atomic database step (see migration 0007): the comment, the status it set and the item's
    // new status and comment count are saved together or not at all.
    const saved = unwrap(
      await db().rpc('respond_to_item', {
        p_item: item.id,
        p_author: commenter(auth).author,
        p_role: commenter(auth).role,
        p_body: text || null,
        p_status: statusChanged ? status : null,
      }),
    );
    const updated = unwrap(await db().from('mail_items').select(LIST_COLUMNS).eq('id', item.id).single());
    const [withComment] = await withLatestComments([updated]);
    return { item: withComment, comment: { ...saved, author: displayAuthor(saved.author), can_delete: saved.body != null } };
  },

  async updateStatus({ req, auth, params }) {
    const { status } = await readJson(req);
    const item = await getItem(params.id);
    requireItemScope(auth, item.category, item.id);
    requirePermission(auth, 'status');
    if (!STATUSES[item.category].includes(status)) throw new HttpError(400, `Invalid status for ${item.category}`);

    const updated = unwrap(
      await db().from('mail_items').update({ status }).eq('id', item.id).select(LIST_COLUMNS).single(),
    );
    return { item: updated };
  },

  // Moves an item to the other tab (fixes a wrong guess by the rules).
  async setCategory({ req, auth, params }) {
    requirePermission(auth, 'manage');
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
    requirePermission(auth, 'manage');
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
    requirePermission(auth, 'notify');
    const { itemId, email, ccEmail, note } = await readJson(req);
    const recipient = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(recipient) || recipient.length > 254) throw new HttpError(400, 'Enter a valid email address for the person to notify');
    const ccList = parseEmails(ccEmail);
    if (ccList.length === 0) throw new HttpError(400, 'Enter at least one CC email address (your own). Everyone listed is copied on the notification');
    if (ccList.length > CC_MAX) throw new HttpError(400, `You can copy up to ${CC_MAX} email addresses`);
    const badCc = ccList.find((address) => !EMAIL_RE.test(address) || address.length > 254);
    if (badCc) throw new HttpError(400, `"${badCc.slice(0, 60)}" is not a valid CC email address`);
    const cleanNote = String(note || '').trim().slice(0, 1000);

    const item = await getItem(itemId, DETAIL_COLUMNS);
    if (item.archived_at) throw new HttpError(409, 'Restore this item from the archive before notifying about it');
    let url;
    let expiresAt = null;
    let recipientAccess = null;
    if (authMode() === 'google') {
      // The email only points at the case. Whoever opens it must sign in with Google and hold a role.
      url = caseLinkUrl(item);
      try {
        recipientAccess = (await accessFor(recipient)).role || 'none';
      } catch {
        recipientAccess = null; // couldn't check; the email still goes out
      }
    } else {
      const ttlDays = envInt('MAGIC_LINK_TTL_DAYS', 7);
      expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
      const token = newToken();
      unwrap(
        await db().from('magic_links').insert({
          token_hash: hashToken(token),
          scope: item.category,
          mail_item_id: item.id,
          recipient_email: recipient,
          expires_at: expiresAt,
          created_by: `${auth.name} <${ccList.join(', ')}>`,
        }),
      );
      url = magicLinkUrl(item.category, token);
    }
    let emailSent = false;
    let emailError = null;
    if (emailConfigured()) {
      try {
        await sendNotificationEmail({ to: recipient, cc: ccList, item, url, notifiedBy: auth.name, note: cleanNote, expiresAt, signIn: authMode() === 'google' });
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
    return {
      item: updated,
      emailSent,
      emailError,
      expiresAt,
      ccEmail: ccList.join(', '),
      ccEmails: ccList,
      ...(recipientAccess ? { recipientAccess } : {}),
      ...(emailSent ? {} : { link: url }),
    };
  },

  // Sync with Webflow. ?mode=quick is the dashboard's automatic check when it is opened (newest page
  // only); without it, the Sync button's full sweep. Only the marketing team can trigger either.
  async ingest({ auth, url }) {
    requirePermission(auth, 'sync');
    return runIngest({ quick: url.searchParams.get('mode') === 'quick' });
  },
};

// ---- Routing --------------------------------------------------------------

const routes = [
  ['GET', /^\/api\/session$/, handlers.session, { auth: 'optional' }],
  ['GET', /^\/api\/admin-names$/, handlers.adminNames, { auth: 'none' }],
  ['POST', /^\/api\/login$/, handlers.login, { auth: 'none' }],
  ['POST', /^\/api\/logout$/, handlers.logout, { auth: 'none' }],
  ['GET', /^\/api\/auth\/google$/, handlers.authStart, { auth: 'none' }],
  ['GET', /^\/api\/auth\/callback$/, handlers.authCallback, { auth: 'none' }],
  ['GET', /^\/api\/items$/, handlers.listItems],
  ['GET', /^\/api\/items\/(?<id>[0-9a-f-]{36})$/, handlers.getItem],
  ['DELETE', /^\/api\/items\/(?<id>[0-9a-f-]{36})$/, handlers.deleteItem],
  ['DELETE', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/comments\/(?<commentId>[0-9a-f-]{36})$/, handlers.deleteComment],
  ['PATCH', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/archive$/, handlers.setArchived],
  ['PATCH', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/status$/, handlers.updateStatus],
  ['POST', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/respond$/, handlers.respond],
  ['PATCH', /^\/api\/items\/(?<id>[0-9a-f-]{36})\/category$/, handlers.setCategory],
  ['POST', /^\/api\/escalate$/, handlers.escalate],
  ['POST', /^\/api\/ingest$/, handlers.ingest],
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

    const body = await handler({ req, res, url, params, auth });
    if (!res.writableEnded) sendJson(res, 200, body);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    console.error('[api]', error);
    sendJson(res, 500, { error: 'Something went wrong' });
  }
}
