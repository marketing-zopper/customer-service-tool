import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Inbox, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { SECTIONS, STATUS_LABELS } from '../sections.js';
import { isStale, lastSyncAt, markSynced } from '../autoSync.js';
import ItemRow from './ItemRow.jsx';
import NotifyModal from './NotifyModal.jsx';
import SearchBox from './SearchBox.jsx';
import Sidebar from './Sidebar.jsx';

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
  const syncingRef = useRef(false); // true while a sync is running, so two never overlap

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

  // A change can finish after you've moved on (switched tab, opened the archive) and the list is
  // empty while the next one loads, so every update must cope with "no list right now".
  const updateItems = (change) => setItems((current) => (current ? change(current) : current));

  const patchItem = (id, patch) =>
    updateItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

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
    updateItems((current) => current.filter((i) => i.id !== item.id));
    try {
      await api.setCategory(item.id, category);
      showToast(`Moved to ${category === 'partnership' ? 'Partnership' : 'Complaints / Enquiries'}`);
    } catch (err) {
      showToast(err.message, 'error');
      await loadRef.current(); // put the real list back (the one on screen may no longer be the one it was removed from)
    }
  }

  async function archiveItem(item, archived) {
    try {
      await api.setArchived(item.id, archived);
      updateItems((current) => current.filter((i) => i.id !== item.id));
      setArchivedCount((count) => Math.max(0, count + (archived ? 1 : -1)));
      showToast(archived ? 'Archived' : 'Restored');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function deleteItem(item) {
    try {
      await api.deleteItem(item.id);
      updateItems((current) => current.filter((i) => i.id !== item.id));
      showToast('Deleted');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /**
   * Pulls new website-form submissions. `quiet` is the automatic background run: it stays silent
   * unless something new arrives or something goes wrong, and only refreshes the list when needed.
   * The Sync button runs it loudly and always refreshes.
   */
  async function runSync({ quiet = false } = {}) {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await api.sync(quiet);
      markSynced();
      const broken = Object.entries(result.sources).filter(([, source]) => source.error);
      if (broken.length) {
        showToast(`Sync problem (${broken.map(([name]) => name).join(', ')}): ${broken[0][1].error}`, 'error');
      } else if (result.processed) {
        await loadRef.current();
        showToast(`${result.processed} new item${result.processed === 1 ? '' : 's'} added`);
      } else if (!quiet) {
        await loadRef.current();
        showToast('Nothing new. Already up to date');
      }
    } catch (err) {
      showToast(quiet ? `Couldn't check for new entries: ${err.message}` : err.message, 'error');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }

  // The effects below must always call the latest versions of these.
  const loadRef = useRef(load);
  loadRef.current = load;
  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;

  // Automatic sync: when the dashboard is opened, and when a tab left open in the background is
  // brought back. Only for the marketing team (shared-link visitors can't sync).
  useEffect(() => {
    if (!isAdmin) return undefined;
    const checkForNew = () => {
      if (document.visibilityState === 'visible' && isStale(lastSyncAt())) runSyncRef.current({ quiet: true });
    };
    checkForNew();
    document.addEventListener('visibilitychange', checkForNew);
    return () => document.removeEventListener('visibilitychange', checkForNew);
  }, [isAdmin]);

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

  const pending = resultsFor !== searchTerm; // a newer search is on its way; the list on screen is stale
  const title = singleItem ? 'Item for your review' : showArchived ? `Archived · ${section.label}` : section.label;
  const subtitle = singleItem
    ? "You were sent this item. Update its status below when you've dealt with it."
    : showArchived
      ? 'Archived items are hidden from the active list. Restore one to bring it back.'
      : items && !searchTerm
        ? `${items.length} ${items.length === 1 ? 'item' : 'items'}`
        : '';

  return (
    <div className="shell">
      <Sidebar session={session} isAdmin={isAdmin} onSignOut={onSignOut} expires={expires} />

      <main className="main">
        <header className="main-head">
          <div className="main-title">
            <h1>{title}</h1>
            {subtitle && <p className="muted main-sub">{subtitle}</p>}
          </div>
          {isAdmin && (
            <button className="btn btn--glass btn--sm" onClick={() => runSync()} disabled={syncing} title="Pull new website form submissions">
              <RefreshCw size={15} className={syncing ? 'spin' : ''} aria-hidden="true" /> {syncing ? 'Syncing…' : 'Sync'}
            </button>
          )}
        </header>

        {!singleItem && (
          <div className="tabs-row">
            <div className="status-tabs" role="group" aria-label="Filter by status">
              {showArchived ? (
                <span className="status-tab status-tab--active">
                  Archived <span className="tab-count">{items?.length ?? archivedCount}</span>
                </span>
              ) : (
                items &&
                items.length > 0 &&
                ['all', ...section.statuses].map((status) => (
                  <button
                    key={status}
                    className={`status-tab${filter === status ? ' status-tab--active' : ''}`}
                    onClick={() => setFilter(status)}
                    aria-pressed={filter === status}
                  >
                    {status === 'all' ? 'All' : STATUS_LABELS[status]} <span className="tab-count">{counts[status]}</span>
                  </button>
                ))
              )}
            </div>
            {isAdmin && (
              <button className="views-link" onClick={() => setShowArchived((value) => !value)} aria-pressed={showArchived}>
                <Archive size={15} aria-hidden="true" />
                {showArchived ? 'Back to active' : 'Archived'}
                {!showArchived && items !== null && <span className="tab-count">{archivedCount}</span>}
              </button>
            )}
          </div>
        )}

        {!singleItem && (
          <div className="toolbar">
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="Search name, email, phone, message…"
              label={`Search ${showArchived ? 'archived ' : ''}${section.tabLabel.toLowerCase()} by name, email, phone or message`}
            />
            {/* Only claim a count once the list on screen really is the answer to this search. */}
            {searchTerm && items && !pending && (
              <p className="muted search-meta" aria-live="polite">
                {items.length} result{items.length === 1 ? '' : 's'} for “{searchTerm}”
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="form-error main-error" role="alert">
            {error}
          </p>
        )}

        <div className="dt" role="table" aria-label={section.label}>
          {items !== null && visible.length > 0 && (
            <div className="dt-head" role="row">
              <div className="dt-th dt-num" role="columnheader">
                #
              </div>
              <div className="dt-th dt-sender" role="columnheader">
                Sender
              </div>
              <div className="dt-th dt-query" role="columnheader">
                Query
              </div>
              <div className="dt-th dt-time" role="columnheader">
                Received
              </div>
              <div className="dt-th dt-status" role="columnheader">
                Status
              </div>
              <div className="dt-th dt-actions" role="columnheader">
                <span className="sr-only">Actions</span>
              </div>
            </div>
          )}

          {items === null ? (
            <div className="dt-skeleton" aria-hidden="true">
              <div className="skeleton" />
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
            <div className={`dt-body${pending ? ' dt-body--pending' : ''}`} role="rowgroup" aria-busy={pending}>
              {visible.map((item, index) => (
                <ItemRow
                  key={item.id}
                  index={index + 1}
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
        </div>
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
