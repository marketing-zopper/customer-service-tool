import { google } from 'googleapis';
import { env } from './config.js';

export const mailbox = () => env('GMAIL_MAILBOX', 'marketingext@zopper.com');

export const gmailConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  // Accept either the raw JSON or a base64 encoding of it (easier to paste into env var UIs).
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

let gmail;

// Service account with domain-wide delegation, impersonating the triage mailbox (read-only).
function client() {
  if (!gmail) {
    const { client_email, private_key } = serviceAccount();
    const auth = new google.auth.JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      subject: mailbox(),
    });
    gmail = google.gmail({ version: 'v1', auth });
  }
  return gmail;
}

/** Ids of inbox messages from the last `days` days, newest first. */
export async function listRecentMessageIds(days, maxPages = 5) {
  const ids = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const { data } = await client().users.messages.list({
      userId: 'me',
      q: `in:inbox newer_than:${days}d`,
      maxResults: 100,
      pageToken,
    });
    ids.push(...(data.messages || []).map((message) => message.id));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

const decode = (data) => Buffer.from(data, 'base64url').toString('utf8');

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function collectParts(part, out = { plain: [], html: [] }) {
  if (!part) return out;
  if (part.mimeType === 'text/plain' && part.body?.data) out.plain.push(decode(part.body.data));
  else if (part.mimeType === 'text/html' && part.body?.data) out.html.push(decode(part.body.data));
  for (const child of part.parts || []) collectParts(child, out);
  return out;
}

const tidy = (text) =>
  text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function parseFrom(value = '') {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (match ? match[2] : value).trim().toLowerCase();
  const name = match ? match[1].trim() : '';
  return { email, name };
}

/** Fetches one message and flattens it into the shape the classifier and the DB want. */
export async function fetchMessage(id) {
  const { data } = await client().users.messages.get({ userId: 'me', id, format: 'full' });

  const headers = {};
  for (const header of data.payload?.headers || []) headers[header.name.toLowerCase()] = header.value;

  const parts = collectParts(data.payload);
  const rawBody = parts.plain.length ? parts.plain.join('\n') : htmlToText(parts.html.join('\n'));
  const body = tidy(rawBody).slice(0, 20_000);
  const { email, name } = parseFrom(headers.from);

  return {
    gmailMessageId: data.id,
    gmailThreadId: data.threadId,
    subject: (headers.subject || '').trim(),
    fromEmail: email,
    fromName: name,
    headers,
    body,
    snippet: body.replace(/\s+/g, ' ').slice(0, 240),
    receivedAt: new Date(Number(data.internalDate) || Date.now()).toISOString(),
  };
}
