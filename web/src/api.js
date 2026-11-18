import { accessToken } from "./auth.js";

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const listJobs = () => call("GET", "/api/jobs");
export const getJob = (id) => call("GET", `/api/jobs/${id}`);
export const deleteJob = (id) => call("DELETE", `/api/jobs/${id}`);

/** Create a job, upload straight to S3 with the presigned POST, return the job id. */
export async function submitImage(blob, { sendEmail }) {
  const { jobId, upload, remainingToday } = await call("POST", "/api/jobs", {
    contentType: blob.type,
    sendEmail,
  });
  const form = new FormData();
  Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
  form.append("file", blob); // must be the last field for S3
  const res = await fetch(upload.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload rejected by S3 (${res.status})`);
  return { jobId, remainingToday };
}

/** Poll until the Lambda has written a result (or give up after ~60 s). */
export async function waitForResult(jobId, { intervalMs = 1500, attempts = 40 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const data = await getJob(jobId);
    if (data.job.status !== "PENDING") return data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for the result. Check History in a moment.");
}
