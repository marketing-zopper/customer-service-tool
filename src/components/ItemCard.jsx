import { useState } from 'react';
import { Archive, ArchiveRestore, ArrowRightLeft, ChevronDown, ChevronUp, Clock, Mail, Send, Trash2, TriangleAlert, UserCheck } from 'lucide-react';
import { api } from '../api.js';
import StatusSelect from './StatusSelect.jsx';

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export default function ItemCard({ item, statuses, canEscalate, onStatusChange, onEscalate, onSort, onMove, onDelete, onArchive, archived }) {
  const [confirming, setConfirming] = useState(false);
  const otherCategory = item.category === 'partnership' ? 'complaint_enquiry' : 'partnership';
  const otherLabel = otherCategory === 'partnership' ? 'Partnership' : 'Complaints';
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState('');

  async function loadBody() {
    setBodyError('');
    try {
      const { item: full } = await api.getItem(item.id);
      setBody(full.body_full || item.body_snippet || '(empty message)');
    } catch (error) {
      setBodyError(error.message);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && body === null) loadBody();
  }

  return (
    <article className="card">
      <div className="card-main">
        <div className="card-meta">
          <span className="meta-item">
            <Mail size={14} aria-hidden="true" />
            <span className="sender">{item.sender_name || item.sender_email}</span>
            {item.sender_name && <span className="muted sender-email">&lt;{item.sender_email}&gt;</span>}
          </span>
          <span className="meta-item muted">
            <Clock size={14} aria-hidden="true" />
            <time dateTime={item.received_at}>{dateFormat.format(new Date(item.received_at))}</time>
          </span>
        </div>

        <h2 className="card-subject">{item.subject || '(no subject)'}</h2>
        {item.body_snippet && <p className="card-snippet">{item.body_snippet}</p>}

        {item.assigned_to &&
          (item.assigned_email_status === 'failed' ? (
            <p className="assigned assigned--failed">
              <TriangleAlert size={14} aria-hidden="true" /> Email to <strong>{item.assigned_to}</strong> was not sent. Use
              Escalate to try again.
            </p>
          ) : (
            <p className="assigned">
              <UserCheck size={14} aria-hidden="true" /> Escalated to <strong>{item.assigned_to}</strong>
            </p>
          ))}

        {open && (
          <div className="card-body">
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
        )}

        <button className="link-btn" onClick={toggle} aria-expanded={open}>
          {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          {open ? 'Hide message' : 'Read full message'}
        </button>
      </div>

      {onSort ? (
        <div className="card-actions">
          <span className="sort-label">Move to</span>
          <button className="btn btn--ghost btn--sm" onClick={() => onSort(item, 'partnership')}>
            Partnership
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => onSort(item, 'complaint_enquiry')}>
            Complaints / Enquiries
          </button>
          {onDelete &&
            (confirming ? (
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
              <button className="link-btn link-btn--danger" onClick={() => setConfirming(true)}>
                <Trash2 size={13} aria-hidden="true" /> Delete
              </button>
            ))}
        </div>
      ) : (
        <div className="card-actions">
          <StatusSelect value={item.status} options={statuses} onChange={(status) => onStatusChange(item, status)} />
          {canEscalate && (
            <button className="btn btn--escalate" onClick={() => onEscalate(item)}>
              <Send size={15} aria-hidden="true" /> Escalate
            </button>
          )}
          {onMove && (
            <button className="link-btn link-btn--muted" onClick={() => onMove(item, otherCategory)}>
              <ArrowRightLeft size={13} aria-hidden="true" /> Move to {otherLabel}
            </button>
          )}
          {onArchive && (
            <button className="link-btn link-btn--muted" onClick={() => onArchive(item, !archived)}>
              {archived ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
              {archived ? 'Restore' : 'Archive'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
