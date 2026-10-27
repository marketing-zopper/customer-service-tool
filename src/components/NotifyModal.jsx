import { useEffect, useRef, useState } from 'react';
import { Check, Copy, TriangleAlert, X } from 'lucide-react';
import { api } from '../api.js';

// The employee's CC address(es) are remembered in this browser so they type them once, not on every item.
const ccKey = (name) => `zst:notify-cc:${name}`;
const readSaved = (name) => {
  try {
    return localStorage.getItem(ccKey(name)) || '';
  } catch {
    return '';
  }
};
const save = (name, value) => {
  try {
    localStorage.setItem(ccKey(name), value);
  } catch {
    /* private mode etc.: just retype next time */
  }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CC_MAX = 10;
const splitEmails = (text) => text.split(/[\s,;]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);

/**
 * Several addresses in one field: each becomes a chip when you type a comma, space or Enter, paste a list,
 * or leave the field. Backspace on an empty field takes the last one back.
 */
function EmailChips({ value, onChange, inputRef, onProblem }) {
  const [draft, setDraft] = useState('');

  function commit(text) {
    const added = [];
    for (const address of splitEmails(text)) {
      if (!EMAIL_RE.test(address)) {
        onProblem(`"${address}" is not a valid email address`);
        setDraft(address);
        return false;
      }
      if (!value.includes(address) && !added.includes(address)) added.push(address);
    }
    if (value.length + added.length > CC_MAX) {
      onProblem(`You can copy up to ${CC_MAX} email addresses`);
      return false;
    }
    onProblem('');
    if (added.length) onChange([...value, ...added]);
    setDraft('');
    return true;
  }

  return (
    <div className="chips">
      {value.map((address) => (
        <span className="chip" key={address}>
          {address}
          <button type="button" onClick={() => onChange(value.filter((a) => a !== address))} aria-label={`Remove ${address}`}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        inputMode="email"
        value={draft}
        onChange={(e) => {
          const text = e.target.value;
          if (/[,;\s]$/.test(text) && text.trim()) commit(text);
          else setDraft(text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (/[,;\s]/.test(text.trim())) {
            e.preventDefault();
            commit(`${draft} ${text}`);
          }
        }}
        placeholder={value.length ? 'Add another…' : 'you@zopper.com'}
        autoComplete="email"
        aria-label="CC Email"
      />
    </div>
  );
}

export default function NotifyModal({ item, adminName, onClose, onNotified }) {
  const [ccList, setCcList] = useState(() => splitEmails(readSaved(adminName)).filter((a) => EMAIL_RE.test(a)));
  const [ccProblem, setCcProblem] = useState('');
  const [email, setEmail] = useState(item.assigned_to || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const firstEmpty = useRef(null);

  useEffect(() => {
    firstEmpty.current?.focus();
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await api.notify(item.id, email, ccList, note);
      save(adminName, ccList.join(', '));
      onNotified(response.item);
      setResult(response);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
    } catch {
      setError('Copy failed. Select the link and copy it manually.');
    }
  }

  const expiry = result?.expiresAt
    ? new Date(result.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="notify-title">
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        {result ? (
          <div className="modal-result">
            <div className={`panel-icon ${result.emailSent ? 'panel-icon--blue' : 'panel-icon--orange'}`}>
              {result.emailSent ? <Check size={22} aria-hidden="true" /> : <TriangleAlert size={22} aria-hidden="true" />}
            </div>
            <h2 id="notify-title">{result.emailSent ? 'Notified' : 'Marked notified, but email not sent'}</h2>
            {result.emailSent ? (
              <p className="muted">
                The full details and a link to this item were emailed to <strong>{email}</strong>, with a copy to{' '}
                <strong>{result.ccEmails?.join(', ') || result.ccEmail}</strong>
                {expiry && <>. The link expires on {expiry}</>}.
              </p>
            ) : (
              <>
                <p className="muted">
                  {result.emailError} Share this link with <strong>{email}</strong> yourself
                  {expiry && <> (expires {expiry})</>}:
                </p>
                <div className="link-box">
                  <input readOnly value={result.link} onFocus={(e) => e.target.select()} aria-label="Magic link" />
                  <button className="btn btn--ghost" onClick={copyLink} type="button">
                    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {error && <p className="form-error">{error}</p>}
              </>
            )}
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2 id="notify-title">Notify concerned entity</h2>
            <p className="muted modal-subject">{item.subject || '(no subject)'}</p>

            <label className="field">
              <span>CC Email</span>
              <small className="hint">
                Add as many as you need (comma, space or Enter between them). Put your own first: everyone listed is copied on the email,
                and replies to it go to all of them.
              </small>
              <EmailChips value={ccList} onChange={setCcList} inputRef={ccList.length ? null : firstEmpty} onProblem={setCcProblem} />
              {ccProblem && <small className="form-error">{ccProblem}</small>}
            </label>

            <label className="field">
              <span>Recipient's Email</span>
              <input
                ref={ccList.length ? firstEmpty : null}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@zopper.com"
                required
              />
            </label>

            <label className="field">
              <span>
                Note <span className="muted">(optional)</span>
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Why does this need their attention?"
              />
            </label>

            <p className="hint">
              They'll get the complete details of this query plus a link that opens only this item and lets them update its
              status. The link expires after a few days.
            </p>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn--escalate-solid" disabled={busy || !email || ccList.length === 0}>
                {busy ? 'Sending…' : 'Send notification'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
