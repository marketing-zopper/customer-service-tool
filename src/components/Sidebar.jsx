import { NavLink } from 'react-router-dom';
import { Handshake, LogOut, MessageSquareWarning } from 'lucide-react';
import { SECTIONS } from '../sections.js';

const NAV_ICONS = { partnership: Handshake, complaints: MessageSquareWarning };

const initialsOf = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

/** The dark, translucent left rail: brand, the two sections, and who is signed in. */
export default function Sidebar({ session, isAdmin, onSignOut, expires }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">
          <img src="/logo.png" alt="" width="26" height="26" />
        </span>
        <span className="sidebar-name">Zopper Service Triage</span>
      </div>

      {isAdmin && (
        <nav className="sidebar-nav" aria-label="Sections">
          <p className="sidebar-label">Triage</p>
          {Object.values(SECTIONS).map((section) => {
            const Icon = NAV_ICONS[section.slug];
            return (
              <NavLink key={section.slug} to={`/dashboard/${section.slug}`} className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}>
                <Icon size={18} aria-hidden="true" />
                <span>{section.tabLabel}</span>
              </NavLink>
            );
          })}
        </nav>
      )}

      <div className="sidebar-spacer" />

      <div className="sidebar-user">
        <span className="sidebar-avatar" aria-hidden="true">
          {isAdmin ? initialsOf(session.name) : '↗'}
        </span>
        <span className="sidebar-user-text">
          <strong>{isAdmin ? session.name : 'Shared link'}</strong>
          <small>{isAdmin ? 'Marketing team' : expires ? `Valid until ${expires}` : 'Limited access'}</small>
        </span>
        {isAdmin && (
          <button className="sidebar-signout" onClick={onSignOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        )}
      </div>
    </aside>
  );
}
