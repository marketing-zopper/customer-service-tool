/**
 * Rules-only classification (no LLM). Outcome of classifying one email:
 *   partnership | complaint_enquiry   -> shown on that dashboard tab
 *   lead                              -> stored with is_lead = true, shown on neither tab
 *   unsorted                          -> rules can't tell; shown on the admin-only "Needs sorting" tab
 *   ignore                            -> auto-replies, bounces, no-reply senders, job seekers; not stored
 */

export const PARTNERSHIP_RE =
  /\b(partnerships?|partners?|partner with|partnering|collaborat\w*|collab|sponsor\w*|affiliates?|co-?market\w*|tie-?ups?|brand ambassador|influencer|resellers?|channel partner|joint venture|white[- ]?label|distribution|integration|alliance|b2b2c|api|onboard\w*|service partner|become (?:a|your) partner|franchis\w*|dealership|embed\w*|platform|proposal|revenue[- ]shar\w*|commercial (?:terms|models?)|nda|introductory (?:call|meeting|discussion)|marketplace|startup|mou|b2b|enterprise|pilot|underwrit\w*|commissions?|commercials?|our (?:apps?|platform|users|customers|network|merchants|clients|travellers|riders))\b/gi;

// Complaints: clear distress words count fully; everyday service/insurance vocabulary ("claims",
// "policy", "service"...) also shows up in partnership pitches, so it counts for half.
export const COMPLAINT_STRONG_RE =
  /\b(complaints?|complain\w*|refunds?|grievance|escalat\w*|not working|not received|no one (?:called|contacted)|cancel\w*|chargeback|unresolved|poor service|reimburse\w*|ombudsman|legal notice|fraud|harass\w*|no response|not (?:getting|able)|dissatisf\w*|disappoint\w*)\b/gi;

export const COMPLAINT_WEAK_RE =
  /\b(claims?|warranty|damage\w*|repair\w*|policy|plan|issue|problem|help|support|query|assist\w*|status|delay\w*|pending|service[sd]?|servicing|technician|replace\w*|display|screen|touch|battery|charging|broken|installation|call me|contact me|follow ?up)\b/gi;

// Students and job seekers asking for an internship or a job. These never belong on any tab.
export const JOB_SEEKER_RE =
  /\b(interns?|internships?|trainee(?:ship)?|freshers?|resumes?|curriculum vitae|cv|vacanc(?:y|ies)|join (?:your|the|our) (?:company|team|organi[sz]ation|zopper)|(?:become|be|work as) (?:a |an )?(?:posp|pos|retailer|agent)|posp|agent id|job (?:openings?|opportunit\w*|vacanc\w*|profile|role|offer)|(?:looking|searching|seeking|applying) for (?:a |an )?(?:job|employment|opportunit\w*|position)|apply(?:ing)? for (?:the |a )?(?:position|post|job)|suitable opportunit\w*|relevant openings?|(?:openings?|vacanc\w*) (?:in|at|for|within) (?:your|the) (?:company|organi[sz]ation|team)|work (?:in|on|with|for) your company|immediate joiner|immediately joiner|notice period|years of (?:professional |work )?experience)\b/i;

export const isJobSeeker = (text) => JOB_SEEKER_RE.test(text);

// Purchase intent, with no partnership or complaint wording anywhere, is treated as a lead.
const LEAD_RE =
  /\b(quote|quotation|pricing|price list|premium|demo|bulk order|corporate plan|group (?:health )?insurance|employee health|want to buy|interested in buying|purchase)\b/i;

const AUTOMATED_SENDER_RE = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounce[s]?)(\+|@|-|\.)/i;

// Short messages ("AC service pending") can't carry much evidence, so they need less of it.
const SHORT_MESSAGE = 300;

// A one-letter message from a "founder" tells us nothing.
const MIN_MESSAGE_FOR_BOOST = 10;

const hits = (regex, text) => Math.min((text.match(regex) || []).length, 6);
const complaintScore = (text) => hits(COMPLAINT_STRONG_RE, text) + hits(COMPLAINT_WEAK_RE, text) * 0.5;

export function isAutomated({ fromEmail, headers }) {
  const autoSubmitted = headers['auto-submitted'];
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;
  if (headers['x-autoreply'] || headers['x-autorespond']) return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(headers.precedence || '')) return true;
  return AUTOMATED_SENDER_RE.test(fromEmail);
}

/**
 * Scores each side (a subject hit counts 3x a body hit) and only decides when one side clearly
 * wins: it needs enough points (3, or just 0.5 for a short message) and at least twice the other
 * side's score. Anything murkier is `unsorted`.
 */
export function classifyByRules({ subject, bodyHead, businessContact = false }) {
  let partnership = hits(PARTNERSHIP_RE, subject) * 3 + hits(PARTNERSHIP_RE, bodyHead);
  const complaint = complaintScore(subject) * 3 + complaintScore(bodyHead);
  const needed = bodyHead.length < SHORT_MESSAGE ? 0.5 : 3;

  // Web-form enquiries have no real subject, so purchase wording anywhere in the message counts.
  if (partnership === 0 && complaint === 0 && LEAD_RE.test(`${subject}\n${bodyHead}`)) return 'lead';

  // A senior person at a named organisation, with nothing that sounds like a complaint, is a
  // business enquiry even when the message is a single line ("Interested in the product").
  if (businessContact && complaint === 0 && bodyHead.trim().length >= MIN_MESSAGE_FOR_BOOST) partnership += 3;
  if (partnership >= needed && partnership >= complaint * 2) return 'partnership';
  if (complaint >= needed && complaint >= partnership * 2) return 'complaint_enquiry';
  return 'unsorted';
}

/**
 * @param {{ subject: string, fromEmail: string, body: string, classifyText?: string, businessContact?: boolean, snippet: string, headers: Record<string,string> }} email
 *   `classifyText`, when given, is judged instead of `body` (web forms: just the message, not the contact details).
 *   `businessContact` is set for web forms where the sender gave an organisation and a senior title.
 * @returns {{ outcome: 'partnership'|'complaint_enquiry'|'lead'|'unsorted'|'ignore', snippet: string }}
 */
export function classifyEmail(email) {
  if (isAutomated(email)) return { outcome: 'ignore', snippet: email.snippet };
  const text = email.classifyText ?? email.body;
  // Only drop clear job seekers: a complaint or a business proposal that happens to say
  // "internship" or "notice period" must still reach the team.
  const head = text.slice(0, 1500);
  if (isJobSeeker(`${email.subject}\n${head}`) && !hits(COMPLAINT_STRONG_RE, head) && hits(PARTNERSHIP_RE, head) < 2) {
    return { outcome: 'ignore', snippet: email.snippet };
  }
  const outcome = classifyByRules({ subject: email.subject, bodyHead: text.slice(0, 1500), businessContact: email.businessContact });
  return { outcome, snippet: email.snippet };
}
