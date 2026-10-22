// Builds the database filters for the dashboard search box.
//
// Every word the user types must appear somewhere in the item (so "acme founder" finds items that
// mention both), and a word matches if it appears in the subject, sender name, sender email, or the
// full message, which for website forms also holds the phone number, organisation and designation.

const SEARCH_COLUMNS = ['subject', 'sender_name', 'sender_email', 'body_full'];
const MAX_QUERY_LENGTH = 100;
const MAX_WORDS = 6;

/**
 * @param {unknown} raw what the user typed
 * @returns {string[]} one PostgREST `or` filter per word (they are ANDed together); empty = no search
 */
export function searchFilters(raw) {
  const words = String(raw ?? '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);

  return words.map((word) => {
    // 1) make % _ and \ in what they typed match literally instead of acting as LIKE wildcards
    const pattern = `%${word.replace(/[\\%_]/g, '\\$&')}%`;
    // 2) quote it for the filter string, so commas, parentheses and dots can't change the query
    const quoted = `"${pattern.replace(/[\\"]/g, '\\$&')}"`;
    return SEARCH_COLUMNS.map((column) => `${column}.ilike.${quoted}`).join(',');
  });
}
