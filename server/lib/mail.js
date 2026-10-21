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

function renderEscalationEmail({ item, url, escalatedBy, note, expiresAt }) {
  const label = CATEGORY_LABELS[item.category];
  const sender = item.sender_name ? `${item.sender_name} (${item.sender_email})` : item.sender_email;
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F4F6FA;font-family:Poppins,'Segoe UI',Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#1F4091;padding:20px 28px;">
          <img src="${appUrl()}/logo.png" alt="Zopper" width="36" height="36" style="vertical-align:middle;border-radius:8px;background:#fff;">
          <span style="vertical-align:middle;margin-left:10px;color:#ffffff;font-size:16px;font-weight:600;">Zopper Service Triage</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#EE773D;">${escapeHtml(label)} &middot; needs your attention</p>
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;font-weight:600;color:#1F4091;">${escapeHtml(item.subject || '(no subject)')}</h1>
          <p style="margin:0 0 6px;font-size:13px;color:#6B7280;">From ${escapeHtml(sender)}</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#374151;border-left:3px solid #19B4EA;padding-left:12px;">${escapeHtml(item.body_snippet || '')}</p>
          ${note ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;"><strong>Note from ${escapeHtml(escalatedBy)}:</strong> ${escapeHtml(note)}</p>` : `<p style="margin:0 0 20px;font-size:14px;color:#374151;">${escapeHtml(escalatedBy)} from the marketing team has escalated this to you.</p>`}
          <a href="${url}" style="display:inline-block;background:#EE773D;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">Review this item</a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#6B7280;">This link opens only this item and lets you update its status. Please don't forward it.${expiry ? ` It expires on ${expiry}.` : ''}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${label}: ${item.subject || '(no subject)'}`,
    `From: ${sender}`,
    '',
    item.body_snippet || '',
    '',
    note ? `Note from ${escalatedBy}: ${note}` : `${escalatedBy} from the marketing team has escalated this to you.`,
    '',
    `Review this item: ${url}`,
    expiry ? `Link expires on ${expiry}.` : '',
  ].join('\n');

  return { html, text };
}

/** Sends the escalation email through Resend. Throws on failure. */
export async function sendEscalationEmail({ to, item, url, escalatedBy, note, expiresAt }) {
  const { html, text } = renderEscalationEmail({ item, url, escalatedBy, note, expiresAt });
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env('MAIL_FROM', 'Zopper Service Triage <onboarding@resend.dev>'),
      to: [to],
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
