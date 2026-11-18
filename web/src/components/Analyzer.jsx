import { useEffect, useRef, useState } from "react";
import { submitImage, waitForResult } from "../api.js";
import { prepareImage } from "../image.js";
import ResultView from "./ResultView.jsx";

export default function Analyzer() {
  const [blob, setBlob] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sendEmail, setSendEmail] = useState(false);
  const [stage, setStage] = useState("idle"); // idle | uploading | analyzing | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

  async function choose(file) {
    if (!file) return;
    setError(null);
    setResult(null);
    setStage("idle");
    try {
      const prepared = await prepareImage(file);
      setBlob(prepared);
      setPreview(URL.createObjectURL(prepared));
    } catch (err) {
      setError(err.message);
    }
  }

  async function analyze() {
    setError(null);
    try {
      setStage("uploading");
      const { jobId } = await submitImage(blob, { sendEmail });
      setStage("analyzing");
      setResult(await waitForResult(jobId));
      setStage("done");
    } catch (err) {
      setError(err.message);
      setStage("idle");
    }
  }

  const busy = stage === "uploading" || stage === "analyzing";

  if (stage === "done" && result) {
    return (
      <section className="card">
        <ResultView job={result.job} imageUrl={result.imageUrl} />
        <button className="secondary" onClick={() => { setBlob(null); setPreview(null); setResult(null); setStage("idle"); }}>
          Analyze another photo
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${preview ? "has-image" : ""}`}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]); }}
        role="button"
        tabIndex={0}
        aria-label="Choose a photo"
      >
        {preview ? (
          <img src={preview} alt="Selected photo preview" className={busy ? "scanning" : ""} />
        ) : (
          <div className="dropzone-empty">
            <strong>Drop a photo here</strong>
            <span className="muted">or click to choose · JPEG, PNG or WebP</span>
          </div>
        )}
        {busy && <div className="scanline" aria-hidden="true" />}
      </div>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
        onChange={(e) => choose(e.target.files[0])} />

      <div className="controls">
        <label className="checkbox">
          <input type="checkbox" checked={sendEmail} disabled={busy}
            onChange={(e) => setSendEmail(e.target.checked)} />
          Email me the result
        </label>
        <button className="primary" disabled={!blob || busy} onClick={analyze}>
          {stage === "uploading" ? "Uploading…" : stage === "analyzing" ? "Analyzing…" : "Analyze"}
        </button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  );
}
