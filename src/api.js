export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The magic-link token travels in a header, not in API URLs, so it stays out of access logs.
let magicToken = null;
export const setMagicToken = (token) => {
  magicToken = token || null;
};

async function attempt(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(magicToken ? { 'x-magic-token': magicToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // No JSON error body usually means the server itself was briefly down (restart, cold start).
    const fallback = response.status >= 500 ? "The server didn't respond. Please try again in a moment." : 'Something went wrong';
    throw new ApiError(response.status, data.error || fallback);
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads are safe to repeat, so a brief outage is retried instead of shown to the user.
// Writes (status changes, notifications, deletes) are never retried automatically.
async function request(path, options = {}) {
  const isRead = !options.method || options.method === 'GET';
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt(path, options);
    } catch (error) {
      const transient = error.status === 0 || error.status >= 500;
      if (!isRead || !transient || tries >= 2) throw error;
      await sleep(600 * (tries + 1));
    }
  }
}

export const api = {
  session: () => request('/session'),
  adminNames: () => request('/admin-names'),
  login: (name, password) => request('/login', { method: 'POST', body: { name, password } }),
  logout: () => request('/logout', { method: 'POST' }),
  listItems: (category, archived = false, query = '') =>
    request(`/items?category=${category}${archived ? '&archived=1' : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`),
  setArchived: (id, archived) => request(`/items/${id}/archive`, { method: 'PATCH', body: { archived } }),
  getItem: (id) => request(`/items/${id}`),
  respond: (id, status, comment) => request(`/items/${id}/respond`, { method: 'POST', body: { status, comment } }),
  setStatus: (id, status) => request(`/items/${id}/status`, { method: 'PATCH', body: { status } }),
  deleteItem: (id) => request(`/items/${id}`, { method: 'DELETE' }),
  deleteComment: (itemId, commentId) => request(`/items/${itemId}/comments/${commentId}`, { method: 'DELETE' }),
  setCategory: (id, category) => request(`/items/${id}/category`, { method: 'PATCH', body: { category } }),
  notify: (itemId, email, ccEmail, note) => request('/escalate', { method: 'POST', body: { itemId, email, ccEmail, note } }),
  // quick = the automatic background check; the Sync button does a full sweep.
  sync: (quick = false) => request(`/ingest${quick ? '?mode=quick' : ''}`, { method: 'POST' }),
};
