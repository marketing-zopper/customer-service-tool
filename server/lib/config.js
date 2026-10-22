export const CATEGORIES = ['partnership', 'complaint_enquiry'];

// Both tabs share one status set. 'active' is the default for new items; 'notified' is set
// automatically when someone is notified about the item.
export const STATUS_LIST = ['active', 'in_review', 'notified', 'resolved'];
export const STATUSES = {
  partnership: STATUS_LIST,
  complaint_enquiry: STATUS_LIST,
};

// URL segment used by the dashboard for each category
export const SECTION_SLUGS = {
  partnership: 'partnership',
  complaint_enquiry: 'complaints',
};

export function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function envInt(name, fallback) {
  const parsed = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function appUrl() {
  return env('APP_URL', 'http://localhost:5173').replace(/\/+$/, '');
}
