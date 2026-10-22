import { Component } from 'react';
import { TriangleAlert } from 'lucide-react';

/**
 * Last line of defence: if anything in the app throws while rendering, show a calm "reload" screen
 * instead of a blank page. (Nothing is lost: every change is saved on the server as it's made.)
 */
export default class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('[app crashed]', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="center-screen">
        <div className="panel panel--narrow">
          <img src="/logo.png" alt="Zopper" width="40" height="40" className="panel-logo" />
          <div className="panel-icon panel-icon--orange">
            <TriangleAlert size={22} aria-hidden="true" />
          </div>
          <h1>Something went wrong</h1>
          <p className="muted">The page hit an unexpected problem. Your changes are saved. Reloading usually fixes it.</p>
          <div className="panel-actions">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </main>
    );
  }
}
