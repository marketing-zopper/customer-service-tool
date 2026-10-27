import { appUrl, env, SECTION_SLUGS } from './config.js';

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
  const facts = [
    ['From', from],
    ['Phone', details.Phone],
    ['Organisation', details.Organisation],
    ['Designation', details.Designation],
    ['Received', formatIst(item.received_at)],
    ['Submitted via', details['Submitted via']],
  ].filter(([, value]) => value);
  return { facts, message: message || item.body_snippet || '' };
}

export function renderNotificationEmail({ item, url, notifiedBy, notifiedByEmail, note, expiresAt }) {
  const label = CATEGORY_LABELS[item.category];
  const { facts, message } = buildFacts(item);
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  // The first CC address is the person who pressed Notify; any others are copied in as well.
  const [notifierEmail, ...alsoCopied] = [].concat(notifiedByEmail);
  const intro =
    `${notifiedBy} (${notifierEmail}) from the marketing team has notified you about this ${label.toLowerCase()}.` +
    (alsoCopied.length ? ` Also copied: ${alsoCopied.join(', ')}.` : '');

  const factRows = facts
    .map(
      ([name, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;font-size:13px;color:#6B7280;white-space:nowrap;vertical-align:top;">${escapeHtml(name)}</td><td style="padding:6px 0;font-size:14px;color:#111827;overflow-wrap:anywhere;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F4F6FA;font-family:Poppins,'Segoe UI',Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#1F4091;padding:20px 28px;">
          <img src="${appUrl()}/logo.png" alt="Zopper" width="36" height="36" style="vertical-align:middle;border-radius:8px;background:#fff;">
          <span style="vertical-align:middle;margin-left:10px;color:#ffffff;font-size:16px;font-weight:600;">Zopper Service Triage</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#EE773D;">${escapeHtml(label)} &middot; needs your attention</p>
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;font-weight:600;color:#1F4091;">${escapeHtml(item.subject || '(no subject)')}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">${escapeHtml(intro)}</p>
          ${note ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;background:#FDF0E9;border-radius:8px;padding:12px 14px;"><strong>Note from ${escapeHtml(notifiedBy)}:</strong> ${escapeHtml(note)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #E4E7EE;border-bottom:1px solid #E4E7EE;width:100%;">${factRows}</table>
          <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;">Message</p>
          <div style="margin:0 0 24px;font-size:14px;line-height:1.65;color:#111827;white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid #19B4EA;background:#F6F7FA;border-radius:0 8px 8px 0;padding:14px 16px;">${escapeHtml(message || '(no message text)')}</div>
          <a href="${url}" style="display:inline-block;background:#EE773D;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">Review this item</a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#6B7280;">This link opens only this item and lets you set its status and leave a comment for the team. Please don't forward it.${expiry ? ` It expires on ${escapeHtml(expiry)}.` : ''} Reply to this email to reach ${escapeHtml(notifiedBy)}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${label}: ${item.subject || '(no subject)'}`,
    '',
    intro,
    note ? `Note from ${notifiedBy}: ${note}` : '',
    '',
    ...facts.map(([name, value]) => `${name}: ${value}`),
    '',
    'Message:',
    message || '(no message text)',
    '',
    `Review this item: ${url}`,
    expiry ? `Link expires on ${expiry}.` : '',
    `Reply to this email to reach ${notifiedBy}.`,
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');

  return { html, text };
}

/**
 * Sends the notification through Resend. `cc` is one address or a list, the first being the employee
 * who pressed Notify; replies go to all of them, since the message itself is sent from a shared address. Throws on failure.
 */
export async function sendNotificationEmail({ to, cc, item, url, notifiedBy, note, expiresAt }) {
  const ccList = [].concat(cc).filter(Boolean);
  const { html, text } = renderNotificationEmail({ item, url, notifiedBy, notifiedByEmail: ccList, note, expiresAt });
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
