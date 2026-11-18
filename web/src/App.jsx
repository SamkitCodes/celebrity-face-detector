import { useEffect, useState } from "react";
import { currentSession, signOut } from "./auth.js";
import AuthPanel from "./components/AuthPanel.jsx";
import Analyzer from "./components/Analyzer.jsx";
import History from "./components/History.jsx";

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [tab, setTab] = useState("analyze");

  useEffect(() => {
    currentSession().then(setSession);
  }, []);

  const email = session?.getIdToken().decodePayload().email;

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Celebrity Face Detector</h1>
            <p className="tagline">Upload a photo. Find out who&rsquo;s in it.</p>
          </div>
        </div>
        {session && (
          <div className="account">
            <span className="muted">{email}</span>
            <button className="link" onClick={() => { signOut(); setSession(null); }}>Sign out</button>
          </div>
        )}
      </header>

      {session === undefined && <p className="muted center">Loading…</p>}
      {session === null && <AuthPanel onSignedIn={setSession} />}
      {session && (
        <>
          <nav className="tabs" role="tablist">
            {["analyze", "history"].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "tab active" : "tab"}
                onClick={() => setTab(t)}
              >
                {t === "analyze" ? "Analyze" : "History"}
              </button>
            ))}
          </nav>
          {tab === "analyze" ? <Analyzer /> : <History />}
        </>
      )}

      <footer className="footer muted">
        Photos are analyzed with Amazon Rekognition and deleted automatically within 24 hours.
      </footer>
    </div>
  );
}
