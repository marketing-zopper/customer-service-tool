// The two dashboard views. `slug` is the URL segment, `category` matches the database enum.
export const SECTIONS = {
  partnership: {
    slug: 'partnership',
    category: 'partnership',
    label: 'Partnership',
    tabLabel: 'Partnership',
    statuses: ['in_review', 'accepted', 'rejected'],
    emptyText: 'No partnership emails yet.',
  },
  complaints: {
    slug: 'complaints',
    category: 'complaint_enquiry',
    label: 'Complaints / Enquiries',
    tabLabel: 'Complaints',
    statuses: ['in_review', 'escalated_to_team', 'resolved'],
    emptyText: 'No complaints or enquiries yet.',
  },
  // Admin-only holding area for mail the keyword rules couldn't place
  sorting: {
    slug: 'sorting',
    category: 'unsorted',
    label: 'Needs sorting',
    tabLabel: 'Needs sorting',
    statuses: ['in_review'],
    emptyText: 'Nothing waiting. Every email has been sorted.',
    adminOnly: true,
    description: "The rules couldn't tell where these belong. Move each one to the right tab.",
  },
};

export const STATUS_LABELS = {
  in_review: 'In review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  escalated_to_team: 'Escalated to team',
  resolved: 'Resolved',
};

export const sectionForCategory = (category) =>
  Object.values(SECTIONS).find((section) => section.category === category);
