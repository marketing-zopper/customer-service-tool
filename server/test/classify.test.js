import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules, classifyEmail, isAutomated } from '../lib/classify.js';

const email = (overrides) => ({
  subject: '',
  fromEmail: 'someone@example.com',
  body: '',
  snippet: '',
  headers: {},
  ...overrides,
});

test('clear partnership subject', () => {
  assert.equal(classifyByRules({ subject: 'Partnership proposal for Q4', bodyHead: 'We would love to work together.' }), 'partnership');
});

test('clear complaint subject', () => {
  assert.equal(classifyByRules({ subject: 'Complaint about rejected claim', bodyHead: 'My phone screen broke.' }), 'complaint_enquiry');
});

test('body-only evidence: long messages need several hits, short ones just one', () => {
  assert.equal(classifyByRules({ subject: 'Hello', bodyHead: 'We want a collaboration, a co-marketing tie-up and sponsorship.' }), 'partnership');
  assert.equal(classifyByRules({ subject: 'Hello', bodyHead: 'One collaboration idea.' }), 'partnership');
  assert.equal(classifyByRules({ subject: 'Hello', bodyHead: `One collaboration idea. ${'blah '.repeat(80)}` }), 'unsorted');
});

test('everyday insurance words alone do not make a long partnership pitch a complaint', () => {
  const pitch = `We would like a partnership proposal and API integration. Our users file claims, buy a policy and a plan. ${'x '.repeat(150)}`;
  assert.equal(classifyByRules({ subject: 'Hello', bodyHead: pitch }), 'partnership');
  assert.equal(classifyByRules({ subject: 'Hello', bodyHead: 'AC service pending since last week' }), 'complaint_enquiry');
});

test('subject wins over a stray body word, but a real conflict stays unsorted', () => {
  assert.equal(classifyByRules({ subject: 'Partnership proposal', bodyHead: 'Also a question about my claim' }), 'partnership');
  assert.equal(classifyByRules({ subject: 'Partnership and refund', bodyHead: '' }), 'unsorted');
});

test('purchase intent in the subject with nothing else is a lead', () => {
  assert.equal(classifyByRules({ subject: 'Need a quote for 500 devices', bodyHead: 'Please share pricing' }), 'lead');
});

test('purchase wording does not hide a real partnership or complaint', () => {
  assert.equal(classifyByRules({ subject: 'Partnership: pricing for resellers', bodyHead: '' }), 'partnership');
  assert.equal(classifyByRules({ subject: 'Refund for my purchase', bodyHead: '' }), 'complaint_enquiry');
});

test('no signal means unsorted', () => {
  assert.equal(classifyByRules({ subject: 'Hello', bodyHead: 'Hi there' }), 'unsorted');
});

test('automated mail is detected', () => {
  assert.ok(isAutomated({ fromEmail: 'mailer-daemon@googlemail.com', headers: {} }));
  assert.ok(isAutomated({ fromEmail: 'noreply@shop.com', headers: {} }));
  assert.ok(isAutomated({ fromEmail: 'a@b.com', headers: { 'auto-submitted': 'auto-replied' } }));
  assert.ok(isAutomated({ fromEmail: 'a@b.com', headers: { precedence: 'bulk' } }));
  assert.ok(!isAutomated({ fromEmail: 'a@b.com', headers: { 'auto-submitted': 'no' } }));
  assert.ok(!isAutomated({ fromEmail: 'jane@brand.com', headers: {} }));
});

test('students and job seekers are dropped from every tab', () => {
  const ignored = [
    "Good evening sir, I'm Jaya Kumari from Government Engineering College Arwal, data science branch. I want to work on your company as an intern (internship) for 2 months. 1 month offline and 1 month online if any place you have for interns",
    'Hello Sir/Ma\'am, I am reaching out to explore suitable job opportunities within your organization. I have 8+ years of professional experience.',
    'Immediately joiner',
    'Please find my resume attached. I am a fresher looking for a job.',
    'Are there any vacancies in your company?',
  ];
  for (const body of ignored) {
    assert.equal(classifyEmail(email({ subject: 'Contact form – X', body, classifyText: body })).outcome, 'ignore', body.slice(0, 40));
  }
});

test('individuals asking to join as a retailer / POSP / agent are treated like job seekers', () => {
  const ignored = [
    'i am working in the insurance sector, having a base of 2000 plus clients, I want to join your company as a retailer.',
    'want to become posp',
    'SIR MUJHE LOGON MAI SERVICE DENI HAI INSURANCE KI MUJHE AGENT ID CHAHIYE',
  ];
  for (const body of ignored) {
    assert.equal(classifyEmail(email({ subject: 'Contact form – X', body, classifyText: body })).outcome, 'ignore', body.slice(0, 40));
  }
});

test('real customers and partners are not mistaken for job seekers', () => {
  const kept = [
    ['My AC service is pending, technician never came, I want a refund', 'complaint_enquiry'],
    ['Complaint: my notice period for the policy cancellation was ignored and I want a refund', 'complaint_enquiry'],
    ['We run an internship platform and want a partnership and API integration with Zopper', 'unsorted'],
  ];
  for (const [body, expected] of kept) {
    const { outcome } = classifyEmail(email({ subject: 'Contact form – X', body, classifyText: body }));
    assert.notEqual(outcome, 'ignore', body.slice(0, 40));
    if (expected !== 'unsorted') assert.equal(outcome, expected, body.slice(0, 40));
  }
});

test('classifyEmail ignores auto-replies and keeps the snippet otherwise', () => {
  assert.equal(classifyEmail(email({ fromEmail: 'noreply@x.com', subject: 'Partnership' })).outcome, 'ignore');
  const result = classifyEmail(email({ subject: 'Collaboration opportunity', body: 'Hi team', snippet: 'Hi team' }));
  assert.deepEqual(result, { outcome: 'partnership', snippet: 'Hi team', confident: true });
});
