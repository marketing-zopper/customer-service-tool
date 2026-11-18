import { appUrl, env, SECTION_SLUGS } from './config.js';
import { GLOBAL_SUPER_ADMIN } from './employees.js';

const CATEGORY_LABELS = { partnership: 'Partnership', complaint_enquiry: 'Complaint / Enquiry' };

const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function magicLinkUrl(category, token) {
  return `${appUrl()}/dashboard/${SECTION_SLUGS[category]}?token=${encodeURIComponent(token)}`;
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// Website-form items store the visitor's message first and a block of contact details after it
// ("Organisation: …", "Phone: …"). Pull them apart so the email can show each clearly.
const DETAIL_LINE_RE = /^(Organisation|Designation|Phone|Submitted via): (.*)$/;

export function splitMessage(bodyFull = '') {
  const cut = bodyFull.lastIndexOf('\n\n');
  const tail = cut === -1 ? bodyFull : bodyFull.slice(cut + 2);
  const lines = tail.split('\n').filter(Boolean);
  if (lines.length > 0 && lines.every((line) => DETAIL_LINE_RE.test(line))) {
    const details = Object.fromEntries(lines.map((line) => line.match(DETAIL_LINE_RE).slice(1, 3)));
    return { message: cut === -1 ? '' : bodyFull.slice(0, cut).trim(), details };
  }
  return { message: bodyFull.trim(), details: {} };
}

const formatIst = (iso) =>
  `${new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })} IST`;

/** Everything the recipient needs to understand the query without opening the dashboard. */
function buildFacts(item) {
  const { message, details } = splitMessage(item.body_full || '');
  const from = item.sender_name ? `${item.sender_name} <${item.sender_email}>` : item.sender_email;
  // The visitor's message is one more row of the same list, not a separate box.
  const facts = [
    ['Name', from],
    ['Phone', details.Phone],
    ['Organisation', details.Organisation],
    ['Designation', details.Designation],
    ['Received', formatIst(item.received_at)],
    ['Message', message || item.body_snippet || '(no message text)'],
  ].filter(([, value]) => value);
  return { facts };
}

/** A "please give me access" email, prefilled, for someone who was notified but holds no Service Triage role. */
function accessRequestMailto({ recipient, item, url, copy }) {
  const subject = 'Request for Service Triage access';
  const body =
    `Hi,\n\nPlease grant ${recipient} access to Service Triage. I was notified about "${item.subject || 'a case'}" and can't open it yet.\n\n` +
    `Case: ${url}\n\nThanks`;
  const params = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body)}`];
  if (copy.length) params.unshift(`cc=${copy.map(encodeURIComponent).join(',')}`);
  return `mailto:${encodeURIComponent(env('ACCESS_REQUEST_EMAIL', GLOBAL_SUPER_ADMIN))}?${params.join('&')}`;
}

export function renderNotificationEmail({ item, url, notifiedBy, notifiedByEmail, note, expiresAt, signIn = false, recipient = '', requestAccess = false }) {
  const label = CATEGORY_LABELS[item.category];
  const { facts } = buildFacts(item);
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const requestUrl = requestAccess ? accessRequestMailto({ recipient, item, url, copy: [].concat(notifiedByEmail).filter(Boolean) }) : null;

  const factRows = facts
    .map(([name, value]) => {
      const long = name === 'Message';
      return `<tr><td style="padding:6px 16px 6px 0;font-size:13px;color:#6B7280;white-space:nowrap;vertical-align:top;">${escapeHtml(name)}</td><td style="padding:6px 0;font-size:14px;line-height:${long ? '1.6' : 'normal'};color:#111827;overflow-wrap:anywhere;${long ? 'white-space:pre-wrap;' : ''}">${escapeHtml(value)}</td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F4F6FA;font-family:Poppins,'Segoe UI',Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td align="center" style="background:#1F4091;padding:20px 28px;text-align:center;">
          <img src="${appUrl()}/logo.png" alt="Zopper" width="36" height="36" style="vertical-align:middle;border-radius:8px;background:#fff;">
          <span style="vertical-align:middle;margin-left:10px;color:#ffffff;font-size:16px;font-weight:600;">Zopper</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#EE773D;">${escapeHtml(label)} &middot; needs your attention</p>
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;font-weight:600;color:#1F4091;">${escapeHtml(item.subject || '(no subject)')}</h1>
          ${note ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;background:#FDF0E9;border-radius:8px;padding:12px 14px;"><strong>Note from ${escapeHtml(notifiedBy)}:</strong> ${escapeHtml(note)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid #E4E7EE;border-bottom:1px solid #E4E7EE;width:100%;">${factRows}</table>
          <a href="${url}" style="display:inline-block;margin:0 10px 8px 0;background:#EE773D;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;border:2px solid #EE773D;">Review this item</a>
          ${requestUrl ? `<a href="${escapeHtml(requestUrl)}" style="display:inline-block;margin:0 0 8px;background:#ffffff;color:#1F4091;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;border:2px solid #1F4091;">Request Access</a>` : ''}
          <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#6B7280;">${signIn ? 'You can reply to the same mail to start conversation or review the item on dashboard via the provided link above!' : `This link opens only this item and lets you set its status and leave a comment for the team. Please don't forward it.${expiry ? ` It expires on ${escapeHtml(expiry)}.` : ''} Reply to this email to reach ${escapeHtml(notifiedBy)}.`}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${label}: ${item.subject || '(no subject)'}`,
    '',
    note ? `Note from ${notifiedBy}: ${note}` : '',
    '',
    ...facts.map(([name, value]) => `${name}: ${value}`),
    '',
    `Review this item: ${url}`,
    requestUrl ? `Request access: ${requestUrl}` : '',
    signIn ? 'You can reply to the same mail to start conversation or review the item on dashboard via the provided link above!' : [expiry ? `Link expires on ${expiry}.` : '', `Reply to this email to reach ${notifiedBy}.`].filter(Boolean).join(' '),
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');

  return { html, text };
}

/**
 * Sends the notification through Resend. `cc` is one address or a list, the first being the employee
 * who pressed Notify; replies go to all of them, since the message itself is sent from a shared address. Throws on failure.
 */
export async function sendNotificationEmail({ to, cc, item, url, notifiedBy, note, expiresAt, signIn = false, requestAccess = false }) {
  const ccList = [].concat(cc).filter(Boolean);
  const { html, text } = renderNotificationEmail({ item, url, notifiedBy, notifiedByEmail: ccList, note, expiresAt, signIn, recipient: to, requestAccess });
  // Anyone who is also the recipient doesn't need a copy.
  const copies = ccList.filter((address) => address.toLowerCase() !== to.toLowerCase());
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env('MAIL_FROM', 'Zopper Service Triage <onboarding@resend.dev>'),
      to: [to],
      // If they notified themselves there's nobody else to copy.
      ...(copies.length ? { cc: copies } : {}),
      reply_to: ccList.length > 1 ? ccList : ccList[0],
      subject: `[${CATEGORY_LABELS[item.category]}] ${item.subject || 'Item needs your attention'}`,
      html,
      text,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 300)}`);
  }
}
