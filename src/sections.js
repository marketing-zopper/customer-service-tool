// The two dashboard views. `slug` is the URL segment, `category` matches the database enum.
// Both share one status set: active (default for new items), in review, notified, resolved.
const STATUSES = ['active', 'in_review', 'notified', 'resolved'];

export const SECTIONS = {
  partnership: {
    slug: 'partnership',
    category: 'partnership',
    label: 'Partnership',
    tabLabel: 'Partnership',
    statuses: STATUSES,
    emptyText: 'No partnership items yet.',
  },
  complaints: {
    slug: 'complaints',
    category: 'complaint_enquiry',
    label: 'Complaints / Enquiries',
    tabLabel: 'Complaints',
    statuses: STATUSES,
    emptyText: 'No complaints or enquiries yet.',
  },
};

export const STATUS_LABELS = {
  active: 'Active',
  in_review: 'In review',
  notified: 'Notified',
  resolved: 'Resolved',
};

export const sectionForCategory = (category) =>
  Object.values(SECTIONS).find((section) => section.category === category);
