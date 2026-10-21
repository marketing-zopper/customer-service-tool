import { env } from './config.js';

const API = 'https://api.webflow.com/v2';

// Only these two website forms are triaged; every other form on the site (newsletter, program
// sign-ups, quote forms) is ignored.
export const WEBFLOW_FORMS = ['Lead Generation (Component)', 'Lead Generation (Contact Page)'];

export const webflowConfigured = () => Boolean(process.env.WEBFLOW_API_TOKEN && process.env.WEBFLOW_SITE_ID);

/**
 * READ-ONLY BY DESIGN: this is the only function that talks to Webflow and it only ever sends GET
 * requests. Nothing in this app creates, edits, deletes or publishes anything on the Webflow site.
 */
async function get(path) {
  const response = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Webflow responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const tidy = (value) => value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// Executive titles only. "Manager" and "Owner" are too common among individual customers who just
// fill in the box, so they don't count.
const SENIOR_TITLE_RE =
  /\b(founder|co-?founder|ceo|cto|coo|cfo|cmo|chief|director|vp|avp|svp|vice[- ]president|president|head|general manager|gm|md|managing|partner|alliances?|strategy)\b/i;
const NOT_AN_ORGANISATION_RE = /^(na|n\/a|nil|none|no|nope|-+|\.+|self|individual|personal|customer|student|test)$/i;

/** Did the sender give a real organisation and a senior job title? (Customers tend to write "NA" or a phone model.) */
export function isBusinessContact(organisation, designation) {
  return organisation.length >= 2 && !NOT_AN_ORGANISATION_RE.test(organisation) && SENIOR_TITLE_RE.test(designation);
}

/** Turns one Webflow submission into the shape the classifier and the database use. */
export function toItem(submission) {
  const form = submission.formResponse || {};
  const name = `${text(form['First Name'])} ${text(form['Last Name'])}`.trim();
  const email = text(form.Email).toLowerCase();
  const organisation = text(form.Organisation);
  // The contact form's message box is (confusingly) named "Field" in Webflow.
  const message = tidy(text(form.Field));

  const details = [
    organisation && `Organisation: ${organisation}`,
    text(form.Designation) && `Designation: ${text(form.Designation)}`,
    text(form['Phone Number']) && `Phone: ${text(form['Phone Number'])}`,
    `Submitted via: ${submission.displayName}${submission.publishedPath ? ` (${submission.publishedPath})` : ''}`,
  ].filter(Boolean);

  return {
    sourceId: `webflow:${submission.id}`,
    sourceThreadId: null,
    subject: `Contact form – ${organisation || name || email || 'unknown sender'}`,
    fromEmail: email || 'unknown',
    fromName: name,
    headers: {},
    body: [message, details.join('\n')].filter(Boolean).join('\n\n'),
    classifyText: message, // sort on what they wrote, not on their organisation or phone number
    businessContact: isBusinessContact(organisation, text(form.Designation)),
    snippet: message.replace(/\s+/g, ' ').slice(0, 240),
    receivedAt: new Date(submission.dateSubmitted).toISOString(),
  };
}

/** Submissions of the two triaged forms from the last `days` days, newest first. */
export async function fetchSubmissions(days, maxPages = 30) {
  const site = process.env.WEBFLOW_SITE_ID;
  const cutoff = Date.now() - days * 86_400_000;
  const wanted = new Set(env('WEBFLOW_FORMS', WEBFLOW_FORMS.join('|')).split('|'));
  const items = [];

  for (let page = 0; page < maxPages; page += 1) {
    const { formSubmissions, pagination } = await get(`/sites/${site}/form_submissions?limit=100&offset=${page * 100}`);
    for (const submission of formSubmissions) {
      if (new Date(submission.dateSubmitted).getTime() < cutoff) continue;
      if (wanted.has(submission.displayName)) items.push(toItem(submission));
    }
    const oldest = formSubmissions.at(-1)?.dateSubmitted;
    if (!oldest || new Date(oldest).getTime() < cutoff || (page + 1) * 100 >= pagination.total) break;
  }
  return items;
}
