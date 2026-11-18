import { useEffect, useState } from "react";
import { deleteJob, getJob, listJobs } from "../api.js";
import ResultView from "./ResultView.jsx";

export default function History() {
  const [jobs, setJobs] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  const load = () => listJobs().then((d) => setJobs(d.jobs)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function open(id) {
    setError(null);
    try {
      setSelected(await getJob(id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this photo and its result now?")) return;
    try {
      await deleteJob(id);
      setSelected(null);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (selected) {
    return (
      <section className="card">
        <button className="link back" onClick={() => setSelected(null)}>← Back to history</button>
        <ResultView job={selected.job} imageUrl={selected.imageUrl} />
        <button className="danger" onClick={() => remove(selected.job.jobId)}>Delete now</button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Last 24 hours</h2>
      {error && <p className="notice error">{error}</p>}
      {jobs === null && !error && <p className="muted">Loading…</p>}
      {jobs?.length === 0 && <p className="muted">Nothing yet. Analyze a photo to see it here.</p>}
      <ul className="history">
        {jobs?.map((j) => (
          <li key={j.jobId}>
            <button className="history-row" onClick={() => open(j.jobId)}>
              <span className={`status ${j.status.toLowerCase()}`}>{j.status.toLowerCase()}</span>
              <span className="names">
                {j.status === "DONE"
                  ? (j.celebrities?.map((c) => c.name).join(", ") || "No matches")
                  : j.status === "FAILED" ? j.errorMessage : "Processing…"}
              </span>
              <time className="muted" dateTime={j.createdAt}>
                {new Date(j.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
