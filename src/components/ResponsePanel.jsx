import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../api.js';
import { STATUS_LABELS } from '../sections.js';

const MAX = 2000;

/**
 * "Your response": what the person a query was escalated to uses to reply. The status and the comment
 * are saved together, so the team sees why the status changed. `tone` picks the look: dark for the
 * sidebar, light when it sits in the page on narrow screens.
 */
export default function ResponsePanel({ item, statuses, onSaved, tone = 'light' }) {
  const [status, setStatus] = useState(item.status);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // If the status changes elsewhere (say, the team updated it), follow it.
  useEffect(() => setStatus(item.status), [item.status]);

  // "Notified" describes what the team did, not an answer, so it is only offered if that's where it stands.
  const options = statuses.filter((s) => s !== 'notified' || item.status === 'notified');
  const changed = status !== item.status;
  const hasText = comment.trim().length > 0;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await api.respond(item.id, changed ? status : undefined, comment);
      onSaved(result.item);
      setComment('');
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`response response--${tone}`} onSubmit={submit}>
      <h2>Your response</h2>
      <p className="response-hint">Set the status and leave a comment for the marketing team. They'll see both together.</p>

      <label className="response-field">
        <span>Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}>
          {options.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="response-field">
        <span>Comment</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={5}
          maxLength={MAX}
          disabled={busy}
          placeholder="What happened? What's next?"
        />
        <small className="response-count">
          {comment.length} / {MAX}
        </small>
      </label>

      {error && (
        <p className="response-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="response-saved" role="status">
          <Check size={15} aria-hidden="true" /> Saved. The team can see it.
        </p>
      )}

      <button className="btn btn--escalate-solid btn--block" disabled={busy || (!changed && !hasText)}>
        {busy ? 'Saving…' : changed && hasText ? 'Update status & comment' : changed ? 'Update status' : 'Add comment'}
      </button>
    </form>
  );
}
