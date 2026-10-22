import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Archive, Inbox, LogOut, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { SECTIONS, STATUS_LABELS } from '../sections.js';
import ItemCard from './ItemCard.jsx';
import NotifyModal from './NotifyModal.jsx';
import SearchBox from './SearchBox.jsx';

export default function Dashboard({ session, sectionKey, onSignOut }) {
  const section = SECTIONS[sectionKey];
  const isAdmin = session.role === 'admin';
  const singleItem = session.role === 'link' && session.itemId;

  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  const [notifying, setNotifying] = useState(null);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState(''); // the query actually being searched (debounced)
  const [resultsFor, setResultsFor] = useState(''); // the query the list on screen answers
  const latestRequest = useRef(0);

  const showToast = useCallback((message, tone = 'info') => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Wait for a pause in typing before searching, so each keystroke isn't a request.
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setError('');
    try {
      const data = await api.listItems(section.category, showArchived, searchTerm);
      if (request !== latestRequest.current) return; // a newer search has already replaced this one
      setItems(data.items);
      setResultsFor(searchTerm);
      if (data.archivedCount !== undefined) setArchivedCount(data.archivedCount);
    } catch (err) {
      if (request !== latestRequest.current) return;
      setError(err.message);
      setItems([]);
    }
  }, [section.category, showArchived, searchTerm]);

  // Switching tabs always goes back to the active list.
  useEffect(() => {
    setShowArchived(false);
  }, [section.category]);

  // Changing tab or switching to/from the archive shows a loading state; refining a search does not,
  // so the results update in place instead of flashing.
  useEffect(() => {
    setItems(null);
    setFilter('all');
  }, [section.category, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const patchItem = (id, patch) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  async function changeStatus(item, status) {
    if (status === item.status) return;
    // For admins, "notified" always means picking who to notify, so it opens the Notify form.
    if (isAdmin && status === 'notified') {
      setNotifying(item);
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

  async function moveItem(item, category) {
    const previous = items;
    setItems((current) => current.filter((i) => i.id !== item.id));
    try {
      await api.setCategory(item.id, category);
      showToast(`Moved to ${category === 'partnership' ? 'Partnership' : 'Complaints / Enquiries'}`);
    } catch (err) {
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
                <button className="btn btn--ghost btn--sm" onClick={sync} disabled={syncing} title="Pull new website form submissions">
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
          <div className="page-head-row">
            <h1>{singleItem ? 'Item for your review' : showArchived ? `Archived · ${section.label}` : section.label}</h1>
            {!singleItem && (
              <SearchBox
                value={query}
                onChange={setQuery}
                placeholder="Search name, email, phone, message…"
                label={`Search ${showArchived ? 'archived ' : ''}${section.tabLabel.toLowerCase()} by name, email, phone or message`}
              />
            )}
          </div>
          {singleItem && <p className="muted">You were sent this item. Update its status below when you've dealt with it.</p>}
          {showArchived && <p className="muted">Archived items are hidden from the active list. Restore one to bring it back.</p>}
          {/* Only claim a count once the list on screen really is the answer to this search. */}
          {searchTerm && items && resultsFor === searchTerm && (
            <p className="muted search-meta" aria-live="polite">
              {items.length} result{items.length === 1 ? '' : 's'} for “{searchTerm}”
            </p>
          )}
        </div>

        {!singleItem && (
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
            {isAdmin && (
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
                : searchTerm
                  ? `No results for “${searchTerm}”. Try fewer words, or part of a name, email or phone number.`
                  : showArchived
                    ? 'Nothing archived yet.'
                    : section.emptyText}
            </p>
          </div>
        ) : (
          <div className={`list${resultsFor !== searchTerm ? ' list--pending' : ''}`} aria-busy={resultsFor !== searchTerm}>
            {visible.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                statuses={section.statuses}
                canNotify={isAdmin && !showArchived}
                onStatusChange={changeStatus}
                onNotify={setNotifying}
                onDelete={isAdmin && section.category === 'partnership' ? deleteItem : undefined}
                onMove={isAdmin && !showArchived ? moveItem : undefined}
                onArchive={isAdmin ? archiveItem : undefined}
                archived={showArchived}
              />
            ))}
          </div>
        )}
      </main>

      {notifying && (
        <NotifyModal
          item={notifying}
          adminName={session.name}
          onClose={() => setNotifying(null)}
          onNotified={(updated) => patchItem(updated.id, updated)}
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
