import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchFilters } from '../lib/search.js';

const COLUMNS = ['subject', 'sender_name', 'sender_email', 'body_full'];

test('no search text means no filters', () => {
  for (const empty of [undefined, null, '', '   ', '\n\t']) assert.deepEqual(searchFilters(empty), []);
});

test('one filter per word, each searching every column', () => {
  const filters = searchFilters('acme founder');
  assert.equal(filters.length, 2); // ANDed: both words must appear
  for (const filter of filters) for (const column of COLUMNS) assert.ok(filter.includes(`${column}.ilike.`), column);
  assert.ok(filters[0].includes('%acme%') && filters[1].includes('%founder%'));
});

test('extra spaces are ignored and the number of words is capped', () => {
  assert.equal(searchFilters('  a    b  ').length, 2);
  assert.equal(searchFilters('1 2 3 4 5 6 7 8 9').length, 6);
});

test('very long input is cut off', () => {
  const filters = searchFilters('x'.repeat(5000));
  assert.ok(filters[0].length < 700);
});

test('LIKE wildcards typed by the user match literally', () => {
  // "100%" must look for a percent sign, not "100 followed by anything"; same for _ and \
  assert.ok(searchFilters('100%')[0].includes('%100\\\\%%')); // escaped once for LIKE, again for the quoted filter
  assert.ok(searchFilters('a_b')[0].includes('%a\\\\_b%'));
  assert.ok(searchFilters('a\\b')[0].includes('%a\\\\\\\\b%'));
});

test('quotes, commas, dots and brackets cannot break out of the filter', () => {
  for (const nasty of ['a,b', 'a)b', '(a', 'a.b', 'x"y', 'name.eq.1,or(id.gt.0)', '"quoted"']) {
    const [filter] = searchFilters(nasty);
    // exactly one quoted value per column, and the structure is still column.ilike."..." joined by commas
    const parts = filter.match(/(subject|sender_name|sender_email|body_full)\.ilike\."((?:[^"\\]|\\.)*)"/g) || [];
    assert.equal(parts.length, COLUMNS.length, nasty);
    assert.equal(parts.join(','), filter, nasty);
  }
});
