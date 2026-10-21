import { LockKeyhole } from 'lucide-react';

export default function Restricted({ title, message, onRetry, offerSignIn }) {
  return (
    <main className="center-screen">
      <div className="panel panel--narrow">
        <img src="/logo.png" alt="Zopper" width="40" height="40" className="panel-logo" />
        <div className="panel-icon panel-icon--orange">
          <LockKeyhole size={22} aria-hidden="true" />
        </div>
        <h1>{title}</h1>
        <p className="muted">{message}</p>
        <div className="panel-actions">
          {onRetry && (
            <button className="btn btn--primary" onClick={onRetry}>
              Try again
            </button>
          )}
          {offerSignIn && (
            <button className="btn btn--ghost" onClick={offerSignIn}>
              Marketing team sign in
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
