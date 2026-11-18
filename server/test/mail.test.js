import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotificationEmail, splitMessage } from '../lib/mail.js';

const item = (overrides = {}) => ({
  category: 'partnership',
  subject: 'Contact form – Acme',
  sender_name: 'Asha Rao',
  sender_email: 'asha@acme.com',
  body_snippet: 'short preview',
  body_full: 'Hello,\n\nWe want to partner.\n\nOrganisation: Acme\nDesignation: Founder\nPhone: 9999900000\nSubmitted via: Lead Generation (Contact Page) (/contact-us)',
  received_at: '2026-10-17T05:07:16.435Z',
  ...overrides,
});

const render = (i = item(), extra = {}) =>
  renderNotificationEmail({ item: i, url: 'https://app.test/dashboard/partnership?token=abc', notifiedBy: 'Arpit Jain', notifiedByEmail: 'arpit@zopper.com', note: '', expiresAt: '2026-10-29T00:00:00Z', ...extra });

test('splitMessage separates the visitor message from the contact details', () => {
  const { message, details } = splitMessage(item().body_full);
  assert.equal(message, 'Hello,\n\nWe want to partner.');
  assert.deepEqual(details, {
    Organisation: 'Acme',
    Designation: 'Founder',
    Phone: '9999900000',
    'Submitted via': 'Lead Generation (Contact Page) (/contact-us)',
  });
});

test('splitMessage leaves ordinary text alone, and copes with details-only or empty bodies', () => {
  assert.deepEqual(splitMessage('Just a message\n\nwith two paragraphs'), { message: 'Just a message\n\nwith two paragraphs', details: {} });
  assert.deepEqual(splitMessage('Organisation: Acme\nPhone: 1'), { message: '', details: { Organisation: 'Acme', Phone: '1' } });
  assert.deepEqual(splitMessage(''), { message: '', details: {} });
  // a message that merely ends with something detail-like but has other text in that last block is not split
  assert.equal(splitMessage('Hi\n\nPhone: call me\nthanks').details.Phone, undefined);
});

test('the email shows every detail, the time in IST, and the whole message', () => {
  const { html, text } = render();
  for (const part of [html, text]) {
    assert.ok(part.includes('Asha Rao'));
    assert.ok(part.includes('asha@acme.com'));
    assert.ok(part.includes('9999900000'));
    assert.ok(part.includes('Acme'));
    assert.ok(part.includes('Founder'));
    assert.ok(part.includes('We want to partner.'));
    assert.ok(part.includes('17 Oct 2026')); // 05:07 UTC on the 17th is 10:37 IST the same day
    assert.ok(part.includes('10:37') && part.includes('IST'));
    assert.ok(part.includes('https://app.test/dashboard/partnership?token=abc'));
  }
  // the preview field is not what gets shown
  assert.ok(!html.includes('short preview'));
});

test('a very long message is included in full', () => {
  const long = 'x'.repeat(15000);
  assert.ok(render(item({ body_full: long })).text.includes(long));
});

test('missing pieces are simply left out, not shown as "undefined"', () => {
  const { html, text } = render(item({ sender_name: null, body_full: 'Plain message only' }));
  assert.ok(!html.includes('undefined') && !text.includes('undefined') && !html.includes('null'));
  assert.ok(text.includes('Name: asha@acme.com'));
  assert.ok(!text.includes('Phone:') && !text.includes('Organisation:'));
  assert.ok(text.includes('Plain message only'));
  // an empty message falls back to the preview text rather than an empty box
  assert.ok(render(item({ body_full: '', body_snippet: 'the preview' })).text.includes('the preview'));
  assert.ok(render(item({ body_full: '', body_snippet: '' })).text.includes('(no message text)'));
});

test('everything user-supplied is HTML-escaped', () => {
  const { html } = render(item({ subject: '<script>alert(1)</script>', sender_name: '<img src=x>', body_full: '<b>bold</b> & "quotes"' }), { note: '<i>note</i>' });
  for (const raw of ['<script>', '<img src=x>', '<b>bold</b>', '<i>note</i>']) assert.ok(!html.includes(raw), raw);
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;'));
});

test('a note is shown only when given, and there is no "has notified you" intro', () => {
  for (const part of [render().html, render().text]) assert.ok(!/has notified you/.test(part));
  assert.ok(!render().text.includes('Note from'));
  assert.ok(render(item(), { note: 'Please call today' }).text.includes('Note from Arpit Jain: Please call today'));
  assert.match(render().text, /Reply to this email to reach Arpit Jain/); // magic-link wording is unchanged
});

test('the details list is labelled Name, drops "Submitted via", and holds the message as its last row', () => {
  const { html, text } = render();
  assert.ok(text.includes('Name: Asha Rao <asha@acme.com>'));
  assert.ok(!/\bFrom:/.test(text) && !html.includes('>From<'));
  assert.ok(!html.includes('Submitted via') && !text.includes('Submitted via') && !html.includes('Lead Generation'));
  assert.ok(html.includes('>Message</td>'), 'Message is a row of the list, not a separate box');
  assert.ok(!html.includes('border-left:3px solid #19B4EA'));
  assert.ok(text.indexOf('Received:') < text.indexOf('Message: Hello,'));
});

test('the header just says Zopper, centred', () => {
  const { html } = render();
  assert.match(html, /text-align:center;">\s*<img[^>]*alt="Zopper"[\s\S]*?>Zopper<\/span>/);
  assert.ok(!html.includes('Zopper Service Triage'));
});

test('Google-mode footer invites a reply or the dashboard link', () => {
  const { html, text } = render(item(), { signIn: true });
  const line = 'You can reply to the same mail to start conversation or review the item on dashboard via the provided link above!';
  assert.ok(html.includes(line) && text.includes(line));
  assert.ok(!html.includes('This link only takes you'));
});

test('Request Access sits beside Review only when the recipient has no access', () => {
  const none = render(item(), { signIn: true, recipient: 'out@example.com', requestAccess: true });
  assert.ok(none.html.includes('Review this item') && none.html.includes('Request Access'));
  assert.ok(none.html.indexOf('Review this item') < none.html.indexOf('Request Access'));
  const href = none.html.match(/href="(mailto:[^"]+)"/)[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  const url = new URL(href);
  assert.equal(decodeURIComponent(url.pathname), 'marketingext@zopper.com');
  assert.equal(url.searchParams.get('subject'), 'Request for Service Triage access');
  assert.equal(url.searchParams.get('cc'), 'arpit@zopper.com');
  assert.ok(url.searchParams.get('body').includes('out@example.com'));
  assert.ok(none.text.includes('Request access: mailto:'));
  for (const extra of [{ signIn: true }, { signIn: true, requestAccess: false }, {}]) {
    const mail = render(item(), extra);
    assert.ok(!mail.html.includes('Request Access') && !mail.html.includes('mailto:') && !mail.text.includes('Request access'));
  }
});
