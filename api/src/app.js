// Express app. All AWS access is injected through `deps` so tests can run
// without AWS, and server.js wires in the real clients.
import express from "express";
import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_TYPES = { "image/jpeg": "jpg", "image/png": "png" };
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // Rekognition's limit for in-request images
const MIN_UPLOAD_BYTES = 1024;
const JOB_TTL_SECONDS = 24 * 60 * 60;     // matches the S3 1-day lifecycle rule
const PRESIGN_SECONDS = 300;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} deps
 * @param {(token: string) => Promise<{sub: string}>} deps.verifyToken
 * @param {object} deps.db  - { getJob, putJob, listJobs, deleteJob, consumeQuota }
 * @param {object} deps.storage - { presignUpload, presignView, deleteObject }
 * @param {object} deps.config - { dailyUploadLimit }
 * @param {() => Date} [deps.now]
 */
export function createApp({ verifyToken, db, storage, config, now = () => new Date() }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // CloudFront is the only hop in front of us
  app.use(express.json({ limit: "2kb" }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // --- auth: Cognito access token in "Authorization: Bearer <jwt>" ---
  app.use("/api", async (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    if (!match) return next(new HttpError(401, "Missing bearer token"));
    try {
      const payload = await verifyToken(match[1]);
      if (!UUID_RE.test(payload.sub)) throw new Error("bad sub");
      req.userSub = payload.sub;
      next();
    } catch {
      next(new HttpError(401, "Invalid or expired token"));
    }
  });

  app.use("/api", rateLimit({ windowMs: 60_000, max: 60, now }));

  // Create a job and return a presigned POST the browser uploads to directly.
  app.post("/api/jobs", async (req, res) => {
    const { contentType, sendEmail = false } = req.body ?? {};
    const ext = CONTENT_TYPES[contentType];
    if (!ext) throw new HttpError(400, "contentType must be image/jpeg or image/png");
    if (typeof sendEmail !== "boolean") throw new HttpError(400, "sendEmail must be a boolean");

    const date = now();
    const remaining = await db.consumeQuota(req.userSub, date, config.dailyUploadLimit);
    if (remaining < 0) throw new HttpError(429, `Daily limit of ${config.dailyUploadLimit} uploads reached`);

    const jobId = randomUUID();
    const objectKey = `uploads/${req.userSub}/${jobId}.${ext}`;
    await db.putJob(req.userSub, {
      jobId,
      status: "PENDING",
      createdAt: date.toISOString(),
      expiresAt: Math.floor(date.getTime() / 1000) + JOB_TTL_SECONDS,
      objectKey,
      contentType,
      sendEmail,
    });
    const upload = await storage.presignUpload({
      key: objectKey,
      contentType,
      minBytes: MIN_UPLOAD_BYTES,
      maxBytes: MAX_UPLOAD_BYTES,
      expiresIn: PRESIGN_SECONDS,
    });
    res.status(201).json({ jobId, upload, remainingToday: remaining });
  });

  app.get("/api/jobs", async (req, res) => {
    const jobs = await db.listJobs(req.userSub);
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ jobs: jobs.map(publicJob) });
  });

  app.get("/api/jobs/:jobId", async (req, res) => {
    const job = await loadOwnJob(req);
    const imageUrl = await storage.presignView({ key: job.objectKey, expiresIn: PRESIGN_SECONDS });
    res.json({ job: publicJob(job), imageUrl });
  });

  // Users can delete their photo and result immediately (privacy control).
  app.delete("/api/jobs/:jobId", async (req, res) => {
    const job = await loadOwnJob(req);
    await storage.deleteObject({ key: job.objectKey });
    await db.deleteJob(req.userSub, job.jobId);
    res.status(204).end();
  });

  async function loadOwnJob(req) {
    const { jobId } = req.params;
    if (!UUID_RE.test(jobId)) throw new HttpError(400, "Invalid job id");
    // The partition key is the caller's own sub, so other users' jobs are unreachable.
    const job = await db.getJob(req.userSub, jobId);
    if (!job) throw new HttpError(404, "Job not found");
    return job;
  }

  app.use("/api", (req, res, next) => next(new HttpError(404, "Not found")));

  // Express 5 forwards rejected async handlers here. Never leak internals.
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(JSON.stringify({ msg: "unhandled", error: String(err?.stack || err) }));
    res.status(status).json({ error: status === 500 ? "Internal error" : err.message });
  });

  return app;
}

function publicJob(job) {
  const { PK, SK, objectKey, expiresAt, ...rest } = job;
  return rest;
}

// Small fixed-window limiter keyed by user. Fine for one instance; with several
// instances this would move to DynamoDB or CloudFront/WAF.
function rateLimit({ windowMs, max, now }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now().getTime();
    const entry = hits.get(req.userSub);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(req.userSub, { start: t, count: 1 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++entry.count > max) return next(new HttpError(429, "Too many requests"));
    next();
  };
}
