import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { api, setMagicToken } from './api.js';
import { SECTIONS } from './sections.js';
import Gate from './components/Gate.jsx';
import Restricted from './components/Restricted.jsx';
import Dashboard from './components/Dashboard.jsx';
import Splash from './components/Splash.jsx';

// Keeps ?token=... when bouncing between routes, so a magic link survives redirects.
function Redirect({ to }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

function Shell() {
  const { section } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token'); // legacy magic links only
  const caseId = params.get('case'); // an email link to one case: it only points there, it never signs anyone in
  const authNotice = params.get('auth');
  const [signedOut, setSignedOut] = useState(false);
  const [session, setSession] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const loadSession = useCallback(() => {
    setSession(null);
    setLoadError(null);
    setMagicToken(token);
    api
      .session()
      .then(setSession)
      .catch((error) => setLoadError(error.message));
  }, [token]);

  useEffect(loadSession, [loadSession]);

  const signOut = async () => {
    await api.logout().catch(() => {});
    setSignedOut(true); // don't bounce straight back through Google
    setSession({ role: 'anon', ...(session?.authMode ? { authMode: session.authMode } : {}) });
  };

  if (!SECTIONS[section]) return <Redirect to="/dashboard/partnership" />;
  if (loadError) return <Restricted title="We couldn't load this page" message={loadError} onRetry={loadSession} />;
  if (!session) return <Splash />;

  switch (session.role) {
    case 'admin':
    case 'user':
      return <Dashboard session={session} sectionKey={section} onSignOut={signOut} caseId={caseId} />;
    case 'denied':
      return (
        <Restricted
          title="You don't have access to Service Triage"
          message={`${session.email} isn't set up for Service Triage, or its access has been turned off. Ask your admin to assign you a role, then try again.`}
          onRetry={loadSession}
          signInLabel="Use a different Google account"
          offerSignIn={async () => {
            await api.logout().catch(() => {});
            window.location.assign(`/api/auth/google?switch=1&next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          }}
        />
      );
    case 'link':
      // A link only ever unlocks its own section.
      if (session.section !== section) return <Redirect to={`/dashboard/${session.section}`} />;
      return <Dashboard session={session} sectionKey={section} token={token} />;
    case 'invalid':
      return (
        <Restricted
          title="This link has expired or isn't valid"
          message="Magic links stop working after a few days. Ask the person who sent it to notify you about the item again."
          offerSignIn={() => setSession({ role: 'anon' })}
        />
      );
    default:
      return <Gate onSignedIn={setSession} authMode={session.authMode} notice={authNotice} auto={!signedOut} />;
  }
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Redirect to="/dashboard/partnership" />} />
      <Route path="/dashboard/:section" element={<Shell />} />
      <Route path="*" element={<Redirect to="/dashboard/partnership" />} />
    </Routes>
  );
}
