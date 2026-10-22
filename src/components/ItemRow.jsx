import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowRightLeft, ChevronDown, ChevronUp, MessageSquare, Send, Trash2, TriangleAlert, UserCheck } from 'lucide-react';
import { api } from '../api.js';
import StatusSelect from './StatusSelect.jsx';
import { STATUS_LABELS } from '../sections.js';

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const clockFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const commentTime = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const ROLE_LABELS = { responder: 'Responder', team: 'Marketing team' };

// Initials in a soft brand-coloured circle, so rows are quick to tell apart.
const AVATAR_TINTS = ['avatar--blue', 'avatar--orange', 'avatar--navy'];
const initialsOf = (label) =>
  label
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';
const tintOf = (label) => AVATAR_TINTS[[...label].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_TINTS.length];

/** One entry of the table. Everything an item card used to offer lives in this row. */
export default function ItemRow({ index, item, statuses, canNotify, onStatusChange, onNotify, onMove, onDelete, onArchive, archived, readOnlyStatus = false }) {
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState('');
  const [comments, setComments] = useState([]);

  const otherCategory = item.category === 'partnership' ? 'complaint_enquiry' : 'partnership';
  const otherLabel = otherCategory === 'partnership' ? 'Partnership' : 'Complaints';
  const who = item.sender_name || item.sender_email;
  const received = new Date(item.received_at);
  const hasActions = canNotify || onMove || onArchive || (onDelete && !archived);

  async function loadBody() {
    setBodyError('');
    try {
      const { item: full, comments: thread } = await api.getItem(item.id);
      setBody(full.body_full || item.body_snippet || '(empty message)');
      setComments(thread || []);
    } catch (error) {
      setBodyError(error.message);
    }
  }

  // When the item changes on the server (someone replied), refresh an open row's comments.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (open && body !== null) loadBody();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.updated_at, item.comment_count]);

  function openDetail() {
    if (open) return;
    setOpen(true);
    if (body === null) loadBody();
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && body === null) loadBody();
  }

  return (
    <div className={`dt-row${open ? ' dt-row--open' : ''}`} role="row">
      <div className="dt-cell dt-num" role="cell">
        {index}
      </div>

      <div className="dt-cell dt-sender" role="cell">
        <span className={`avatar ${tintOf(who)}`} aria-hidden="true">
          {initialsOf(who)}
        </span>
        <span className="sender-text">
          <span className="sender">{who}</span>
          {item.sender_name && (
            <span className="sender-email" title={item.sender_email}>
              {item.sender_email}
            </span>
          )}
        </span>
      </div>

      <div className="dt-cell dt-query" role="cell">
        <h2 className="query-subject">{item.subject || '(no subject)'}</h2>
        {item.body_snippet && <p className="query-snippet">{item.body_snippet}</p>}
        <div className="query-links">
          <button className="link-btn" onClick={toggle} aria-expanded={open}>
            {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
            {open ? 'Hide message' : 'Read full message'}
          </button>
          {item.comment_count > 0 && (
            <button className="comment-badge" onClick={openDetail} title="Show the comments">
              <MessageSquare size={13} aria-hidden="true" /> {item.comment_count} comment{item.comment_count === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>

      <div className="dt-cell dt-time" role="cell">
        <time dateTime={item.received_at}>
          <span className="time-date">{dateFormat.format(received)}</span>
          <span className="time-clock">{clockFormat.format(received)}</span>
        </time>
      </div>

      <div className="dt-cell dt-status" role="cell">
        <StatusSelect value={item.status} options={statuses} readOnly={readOnlyStatus} onChange={(status) => onStatusChange(item, status)} />
        {item.assigned_to &&
          (item.assigned_email_status === 'failed' ? (
            <p className="assigned assigned--failed">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                Email to <strong>{item.assigned_to}</strong> was not sent. Use Notify to try again.
              </span>
            </p>
          ) : (
            <p className="assigned">
              <UserCheck size={13} aria-hidden="true" />
              <span className="assigned-text">
                <span>Notified</span>
                <strong title={item.assigned_to}>{item.assigned_to}</strong>
              </span>
            </p>
          ))}
      </div>

      {hasActions && (
        <div className="dt-cell dt-actions" role="cell">
          {confirming ? (
            <div className="confirm">
              <span>Delete permanently?</span>
              <button className="btn btn--danger btn--sm" onClick={() => onDelete(item)}>
                Delete
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </div>
          ) : (
            <>
              {canNotify && (
                <button className="btn btn--notify btn--sm" onClick={() => onNotify(item)}>
                  <Send size={14} aria-hidden="true" /> Notify
                </button>
              )}
              {onMove && (
                <button className="btn btn--move btn--sm" onClick={() => onMove(item, otherCategory)}>
                  <ArrowRightLeft size={14} aria-hidden="true" /> Move to {otherLabel}
                </button>
              )}
              {/* Grouped so the two icons always wrap together when space runs out. */}
              {(onArchive || (onDelete && !archived)) && (
                <span className="action-icons">
                  {onArchive && (
                    <button
                      className="icon-action"
                      onClick={() => onArchive(item, !archived)}
                      title={archived ? 'Restore' : 'Archive'}
                      aria-label={archived ? 'Restore' : 'Archive'}
                    >
                      {archived ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
                    </button>
                  )}
                  {onDelete && !archived && (
                    <button className="icon-action icon-action--danger" onClick={() => setConfirming(true)} title="Delete" aria-label="Delete">
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {open && (
        <div className="dt-detail" role="cell">
          <div className="detail-body">
            {body !== null ? (
              body
            ) : bodyError ? (
              <p className="form-error">
                {bodyError}{' '}
                <button className="link-btn link-btn--inline" onClick={loadBody}>
                  Try again
                </button>
              </p>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>

          {comments.length > 0 && (
            <div className="thread">
              <h3>Comments</h3>
              {comments.map((entry) => (
                <article className="thread-entry" key={entry.id}>
                  <header>
                    <strong>{entry.author}</strong>
                    <span className="thread-role">{ROLE_LABELS[entry.author_role] || entry.author_role}</span>
                    <time dateTime={entry.created_at}>{commentTime.format(new Date(entry.created_at))}</time>
                    {entry.status_set && <span className={`thread-status thread-status--${entry.status_set}`}>Set status: {STATUS_LABELS[entry.status_set]}</span>}
                  </header>
                  {entry.body && <p>{entry.body}</p>}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
