// Draws Rekognition bounding boxes (ratios of image width/height) over the photo.
export default function ResultView({ job, imageUrl }) {
  if (job.status === "FAILED") {
    return <p className="notice error">Analysis failed: {job.errorMessage}</p>;
  }
  const celebrities = job.celebrities ?? [];

  return (
    <div className="result">
      <figure className="photo">
        <img src={imageUrl} alt="Analyzed photo" />
        {celebrities.map((c, i) => (
          <div
            key={c.id || i}
            className="box"
            style={{
              left: `${c.boundingBox.Left * 100}%`,
              top: `${c.boundingBox.Top * 100}%`,
              width: `${c.boundingBox.Width * 100}%`,
              height: `${c.boundingBox.Height * 100}%`,
            }}
          >
            <span className="box-label">{i + 1}</span>
          </div>
        ))}
      </figure>

      <div className="matches">
        <h2>{celebrities.length ? `${celebrities.length} match${celebrities.length > 1 ? "es" : ""}` : "No celebrities recognized"}</h2>
        <ol>
          {celebrities.map((c, i) => (
            <li key={c.id || i}>
              <span className="badge">{i + 1}</span>
              <div>
                <strong>{c.name}</strong>
                <div className="meter" aria-label={`${c.confidence}% confidence`}>
                  <span style={{ width: `${c.confidence}%` }} />
                </div>
                <small className="muted">{c.confidence}% confidence</small>
                {c.urls?.length > 0 && (
                  <div className="links">
                    {c.urls.map((u) => (
                      <a key={u} href={u} target="_blank" rel="noopener noreferrer">{new URL(u).hostname.replace("www.", "")}</a>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {job.unrecognizedFaces > 0 && (
          <p className="muted">{job.unrecognizedFaces} other face{job.unrecognizedFaces > 1 ? "s" : ""} detected but not recognized.</p>
        )}
        {job.lowConfidenceMatches > 0 && (
          <p className="muted">{job.lowConfidenceMatches} low-confidence match{job.lowConfidenceMatches > 1 ? "es" : ""} hidden.</p>
        )}
        {job.sendEmail && (
          <p className="muted">
            Email: {job.emailStatus === "SENT" ? "sent ✓" : job.emailStatus === "FAILED" ? "could not be sent" : "sending…"}
          </p>
        )}
      </div>
    </div>
  );
}
