import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toItem } from '../lib/webflow.js';
import { classifyEmail } from '../lib/classify.js';

const submission = (response, extra = {}) => ({
  id: '65f0c0ffee0000000000abcd',
  displayName: 'Lead Generation (Contact Page)',
  publishedPath: '/contact-us',
  dateSubmitted: '2026-10-20T10:00:00.000Z',
  formResponse: {
    'First Name': ' Asha ',
    'Last Name': 'Rao',
    Organisation: 'Acme Pvt Ltd',
    Designation: 'Founder',
    Email: 'Asha@Acme.com ',
    'Phone Number': '9999999999',
    Field: 'We would like to explore a partnership with Zopper.',
    ...response,
  },
  ...extra,
});

test('maps a contact-form submission to a dashboard item', () => {
  const item = toItem(submission({}));
  assert.equal(item.sourceId, 'webflow:65f0c0ffee0000000000abcd');
  assert.equal(item.fromEmail, 'asha@acme.com');
  assert.equal(item.fromName, 'Asha Rao');
  assert.equal(item.subject, 'Contact form – Acme Pvt Ltd');
  assert.equal(item.snippet, 'We would like to explore a partnership with Zopper.');
  assert.equal(item.receivedAt, '2026-10-20T10:00:00.000Z');
  assert.match(item.body, /^We would like to explore a partnership/);
  assert.match(item.body, /Organisation: Acme Pvt Ltd/);
  assert.match(item.body, /Phone: 9999999999/);
  assert.match(item.body, /Submitted via: Lead Generation \(Contact Page\) \(\/contact-us\)/);
});

test('copes with missing fields', () => {
  const item = toItem(submission({ Organisation: '', 'First Name': '', 'Last Name': '', Email: '', Field: '' }));
  assert.equal(item.fromEmail, 'unknown');
  assert.equal(item.subject, 'Contact form – unknown sender');
  assert.equal(item.snippet, '');
});

// What the rules actually decided. Anything they couldn't place is filed under Partnership (the
// catch-all) but flagged `confident: false`; "unsorted" here means exactly that.
const verdict = (result) => (result.outcome === 'partnership' && result.confident === false ? 'unsorted' : result.outcome);

test('a senior person at a named organisation with a bare product enquiry is a partnership', () => {
  const sort = (response) => verdict(classifyEmail(toItem(submission(response))));
  const axis = { Field: 'Interested in the insurance tech product.', Organisation: 'Axis Bank', Designation: 'VP' };
  assert.equal(sort(axis), 'partnership');
  // no real organisation / title: nothing to go on, so a human decides
  assert.equal(sort({ ...axis, Organisation: 'NA', Designation: 'NA' }), 'unsorted');
  assert.equal(sort({ ...axis, Designation: 'student' }), 'unsorted');
  // everyday titles that individual customers type don't count, and neither do empty messages
  assert.equal(sort({ ...axis, Designation: 'Owner', Field: 'About my phone insurance' }), 'unsorted');
  assert.equal(sort({ ...axis, Designation: 'Manager', Field: 'Mobile insurance' }), 'unsorted');
  assert.equal(sort({ ...axis, Designation: 'Founder', Field: 'a' }), 'unsorted');
  // a complaint stays a complaint whoever writes it
  assert.equal(sort({ ...axis, Field: 'My AC service is pending, technician never came' }), 'complaint_enquiry');
  // a purchase enquiry stays a hidden lead, not a partnership
  assert.equal(sort({ ...axis, Field: 'Please send a quotation for employee health insurance' }), 'lead');
});

test('an embedded-insurance pitch is a partnership even without a senior title', () => {
  const pitch =
    'Hello, I run NextEscaype, a registered tourism marketplace in Andhra Pradesh built for solo travellers, connecting them with verified local guides, homestays and vehicle rentals. Our apps are live on Google Play and we are completing an online payment flow ahead of a wider launch. We would like to embed per-trip group personal accident cover with accidental medical expenses for travellers, opt-in at the payment step, premium collected by us and passed on. Could you share: the underwriting insurer, the policy wording and sum insured, exclusions (especially trekking and two-wheeler use), per-trip premium, any minimum commitment or setup fee, the prepaid wallet or billing model, and the claims process. We are API-ready. Thank you.';
  assert.equal(verdict(classifyEmail(toItem(submission({ Field: pitch, Designation: 'NA' })))), 'partnership');
});

test('messages the rules cannot place are filed under Partnership, flagged as unsure', () => {
  const result = classifyEmail(toItem(submission({ Field: 'Hello there', Designation: 'NA' })));
  assert.equal(result.outcome, 'partnership');
  assert.equal(result.confident, false);
  const decided = classifyEmail(toItem(submission({ Field: 'I have a complaint, my refund claim is unresolved.' })));
  assert.deepEqual([decided.outcome, decided.confident], ['complaint_enquiry', true]);
});

test('web enquiries are sorted by what the message says', () => {
  // junk designation: this test is about the message alone
  const sort = (message) => verdict(classifyEmail(toItem(submission({ Field: message, Designation: 'NA' }))));
  assert.equal(sort('We are interested in a white-label API partnership and integration.'), 'partnership');
  assert.equal(sort('I have a complaint, my refund claim is unresolved.'), 'complaint_enquiry');
  assert.equal(sort('Please send a quotation for employee health insurance'), 'lead');
  assert.equal(sort('Hello there'), 'unsorted');
  assert.equal(sort('Immediately joiner'), 'ignore'); // job seekers never reach a tab
});
