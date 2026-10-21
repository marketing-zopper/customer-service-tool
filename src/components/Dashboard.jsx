import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Archive, Inbox, LogOut, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { SECTIONS, STATUS_LABELS } from '../sections.js';
import ItemCard from './ItemCard.jsx';
import EscalateModal from './EscalateModal.jsx';

export default function Dashboard({ session, sectionKey, onSignOut }) {
  const section = SECTIONS[sectionKey];
  const isAdmin = session.role === 'admin';
  const singleItem = session.role === 'link' && session.itemId;

  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  const [escalating, setEscalating] = useState(null);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const showToast = useCallback((message, tone = 'info') => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const canArchive = isAdmin && !section.adminOnly;

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await api.listItems(section.category, showArchived);
      setItems(data.items);
      if (data.archivedCount !== undefined) setArchivedCount(data.archivedCount);
    } catch (err) {
      setError(err.message);
      setItems([]);
    }
  }, [section.category, showArchived]);

  // Switching tabs always goes back to the active list.
  useEffect(() => {
    setShowArchived(false);
  }, [section.category]);

  useEffect(() => {
    setItems(null);
    setFilter('all');
    load();
  }, [load]);

  const patchItem = (id, patch) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  async function changeStatus(item, status) {
    if (status === item.status) return;
    // For admins, "escalated" always means picking who it goes to.
    if (isAdmin && status === 'escalated_to_team') {
      setEscalating(item);
      return;
    }
    const previous = item.status;
    patchItem(item.id, { status });
    try {
      patchItem(item.id, (await api.setStatus(item.id, status)).item);
    } catch (err) {
      patchItem(item.id, { status: previous });
      showToast(err.message, 'error');
    }
  }

  async function sortItem(item, category) {
    const previous = items;
    setItems((current) => current.filter((i) => i.id !== item.id));
    try {
      await api.setCategory(item.id, category);
      showToast(`Moved to ${category === 'partnership' ? 'Partnership' : 'Complaints / Enquiries'}`);    } catch (err) {
      setItems(previous);
      showToast(err.message, 'error');
    }
  }

  async function archiveItem(item, archived) {
    try {
      await api.setArchived(item.id, archived);
      setItems((current) => current.filter((i) => i.id !== item.id));
      setArchivedCount((count) => Math.max(0, count + (archived ? 1 : -1)));
      showToast(archived ? 'Archived' : 'Restored');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function deleteItem(item) {
    try {
      await api.deleteItem(item.id);
      setItems((current) => current.filter((i) => i.id !== item.id));
      showToast('Deleted');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const result = await api.sync();
      await load();
      const broken = Object.entries(result.sources).filter(([, source]) => source.error);
      if (broken.length) {
        showToast(`Sync problem (${broken.map(([name]) => name).join(', ')}): ${broken[0][1].error}`, 'error');
      } else if (result.processed) {
        showToast(`${result.processed} new item${result.processed === 1 ? '' : 's'} added`);
      } else {
        showToast('Nothing new. Already up to date');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSyncing(false);
    }
  }

  const counts = useMemo(() => {
    const result = { all: items?.length ?? 0 };
    for (const status of section.statuses) result[status] = 0;
    for (const item of items ?? []) result[item.status] += 1;
    return result;
  }, [items, section.statuses]);

  const visible = (items ?? []).filter((item) => filter === 'all' || item.status === filter);
  const expires = session.expiresAt
    ? new Date(session.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <img src="/logo.png" alt="" width="32" height="32" />
            <span>Zopper Service Triage</span>
          </div>

          {isAdmin && (
            <nav className="tabs" aria-label="Sections">
              {Object.values(SECTIONS).map((s) => (
                <NavLink key={s.slug} to={`/dashboard/${s.slug}`} className={({ isActive }) => `tab${isActive ? ' tab--active' : ''}`}>
                  {s.tabLabel}
                </NavLink>
              ))}
            </nav>
          )}

          <div className="topbar-user">
            {isAdmin ? (
              <>
                <button className="btn btn--ghost btn--sm" onClick={sync} disabled={syncing} title="Pull new emails from the mailbox">
                  <RefreshCw size={15} className={syncing ? 'spin' : ''} aria-hidden="true" /> <span className="hide-sm">Sync</span>
                </button>
                <span className="user-chip hide-sm">{session.name}</span>
                <button className="icon-btn" onClick={onSignOut} aria-label="Sign out" title="Sign out">
                  <LogOut size={18} />
                </button>
              </>
            ) : (
              <span className="user-chip">Shared link{expires ? ` · until ${expires}` : ''}</span>
            )}
          </div>
        </div>
      </header>

      <main className="content">
        <div className="page-head">
          <h1>{singleItem ? 'Item for your review' : showArchived ? `Archived · ${section.label}` : section.label}</h1>
          {singleItem && <p className="muted">You were sent this item. Update its status below when you've dealt with it.</p>}
          {section.description && <p className="muted">{section.description}</p>}
          {showArchived && <p className="muted">Archived items are hidden from the active list. Restore one to bring it back.</p>}
        </div>

        {!singleItem && !section.adminOnly && (
          <div className="filters" role="group" aria-label="Filter by status">
            {!showArchived &&
              items &&
              items.length > 0 &&
              ['all', ...section.statuses].map((status) => (
                <button
                  key={status}
                  className={`chip${filter === status ? ' chip--active' : ''}`}
                  onClick={() => setFilter(status)}
                  aria-pressed={filter === status}
                >
                  {status === 'all' ? 'All' : STATUS_LABELS[status]} <span className="chip-count">{counts[status]}</span>
                </button>
              ))}
            {canArchive && (
              <button
                className={`chip chip--archive${showArchived ? ' chip--active' : ''}`}
                onClick={() => setShowArchived((value) => !value)}
                aria-pressed={showArchived}
              >
                <Archive size={14} aria-hidden="true" />
                {showArchived ? 'Back to active' : 'Archived'}
                {!showArchived && <span className="chip-count">{archivedCount}</span>}
              </button>
            )}
          </div>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {items === null ? (
          <div className="skeleton-list" aria-hidden="true">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : visible.length === 0 && !error ? (
          <div className="empty">
            <Inbox size={28} aria-hidden="true" />
            <p>
              {items.length > 0
                ? `Nothing marked "${STATUS_LABELS[filter]}".`
                : showArchived
                  ? 'Nothing archived yet.'
                  : section.emptyText}
            </p>
          </div>
        ) : (
          <div className="list">
            {visible.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                statuses={section.statuses}
                canEscalate={isAdmin && !showArchived}
                onStatusChange={changeStatus}
                onEscalate={setEscalating}
                onSort={section.adminOnly ? sortItem : undefined}
                onDelete={section.adminOnly ? deleteItem : undefined}
                onMove={canArchive && !showArchived ? sortItem : undefined}
                onArchive={canArchive ? archiveItem : undefined}
                archived={showArchived}
              />
            ))}
          </div>
        )}
      </main>

      {escalating && (
        <EscalateModal
          item={escalating}
          onClose={() => setEscalating(null)}
          onEscalated={(updated) => patchItem(updated.id, updated)}
        />
      )}

      {toast && (
        <div className={`toast toast--${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
