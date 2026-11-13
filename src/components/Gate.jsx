import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Splash from './Splash.jsx';

const NOTICES = {
  denied: "That Google account doesn't have access to Service Triage. Ask your admin to assign you a Service Triage role, or try another account.",
  cancelled: 'Google sign-in was cancelled.',
  failed: "We couldn't complete the Google sign-in. Please try again.",
  expired: 'That sign-in took too long or was opened twice. Please try again.',
  unavailable: "We couldn't check your access right now. Please try again in a moment.",
};

// Where to send the browser for Google sign-in, returning to the page that was asked for.
const googleUrl = (switchAccount = false) => {
  const here = new URLSearchParams(window.location.search);
  here.delete('auth');
  const search = here.toString();
  return `/api/auth/google?next=${encodeURIComponent(window.location.pathname + (search ? `?${search}` : ''))}${switchAccount ? '&switch=1' : ''}`;
};

/** Google sign-in. Arriving here signed out goes straight to Google (which skips its own prompts when you're already signed in there). */
function GoogleGate({ notice, auto }) {
  const message = NOTICES[notice];
  const redirecting = auto && !message;

  useEffect(() => {
    if (redirecting) window.location.assign(googleUrl());
  }, [redirecting]);

  if (redirecting) return <Splash />;
  return (
    <main className="center-screen">
      <div className="panel panel--narrow">
        <img src="/logo.png" alt="Zopper" width="40" height="40" className="panel-logo" />
        <h1>Zopper Service Triage</h1>
        <p className="muted">Sign in with your Zopper Google account.</p>

        {message && (
          <p className="form-error" role="alert">
            {message}
          </p>
        )}

        <button className="btn btn--primary btn--block" onClick={() => window.location.assign(googleUrl(Boolean(message)))}>
          {message ? 'Try another Google account' : 'Sign in with Google'}
        </button>
      </div>
    </main>
  );
}

export default function Gate({ onSignedIn, authMode, notice, auto }) {
  if (authMode === 'google') return <GoogleGate notice={notice} auto={auto} />;
  return <PasswordGate onSignedIn={onSignedIn} />;
}

// The original shared-password sign-in, used while AUTH_MODE is not 'google'.
function PasswordGate({ onSignedIn }) {
  const [names, setNames] = useState([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .adminNames()
      .then((data) => setNames(data.names))
      .catch((err) => setError(err.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await api.login(name, password));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="center-screen">
      <form className="panel panel--narrow" onSubmit={submit}>
        <img src="/logo.png" alt="Zopper" width="40" height="40" className="panel-logo" />
        <h1>Zopper Service Triage</h1>
        <p className="muted">Marketing team sign in. Received a link by email? Open it directly instead.</p>

        <label className="field">
          <span>Your name</span>
          <select value={name} onChange={(e) => setName(e.target.value)} required>
            <option value="" disabled>
              Select your name
            </option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn--primary btn--block" disabled={busy || !name || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
