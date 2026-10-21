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

async function request(path, { method = 'GET', body } = {}) {
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
  if (!response.ok) throw new ApiError(response.status, data.error || 'Something went wrong');
  return data;
}

export const api = {
  session: () => request('/session'),
  adminNames: () => request('/admin-names'),
  login: (name, password) => request('/login', { method: 'POST', body: { name, password } }),
  logout: () => request('/logout', { method: 'POST' }),
  listItems: (category, archived = false) => request(`/items?category=${category}${archived ? '&archived=1' : ''}`),
  setArchived: (id, archived) => request(`/items/${id}/archive`, { method: 'PATCH', body: { archived } }),
  getItem: (id) => request(`/items/${id}`),
  setStatus: (id, status) => request(`/items/${id}/status`, { method: 'PATCH', body: { status } }),
  deleteItem: (id) => request(`/items/${id}`, { method: 'DELETE' }),
  setCategory: (id, category) => request(`/items/${id}/category`, { method: 'PATCH', body: { category } }),
  escalate: (itemId, email, note) => request('/escalate', { method: 'POST', body: { itemId, email, note } }),
  sync: () => request('/ingest', { method: 'POST' }),
};
