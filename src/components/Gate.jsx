import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Gate({ onSignedIn }) {
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
