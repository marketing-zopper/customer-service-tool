export const CATEGORIES = ['partnership', 'complaint_enquiry', 'unsorted'];

// Categories an item can be moved into by hand from "Needs sorting"
export const SORT_TARGETS = ['partnership', 'complaint_enquiry'];

export const STATUSES = {
  partnership: ['in_review', 'accepted', 'rejected'],
  complaint_enquiry: ['in_review', 'escalated_to_team', 'resolved'],
  unsorted: ['in_review'],
};

// URL segment used by the dashboard for each category
export const SECTION_SLUGS = {
  partnership: 'partnership',
  complaint_enquiry: 'complaints',
  unsorted: 'sorting',
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
