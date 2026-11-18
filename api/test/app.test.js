// API tests with in-memory fakes: no AWS, no network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

function setup({ limit = 2 } = {}) {
  const jobs = new Map(); // `${sub}|${jobId}` -> job
  const quota = new Map();
  const deleted = [];
  const db = {
    async getJob(sub, id) { return jobs.get(`${sub}|${id}`); },
    async putJob(sub, job) { jobs.set(`${sub}|${job.jobId}`, { PK: `USER#${sub}`, SK: `JOB#${job.jobId}`, ...job }); },
    async listJobs(sub) { return [...jobs.entries()].filter(([k]) => k.startsWith(sub)).map(([, v]) => v); },
    async deleteJob(sub, id) { jobs.delete(`${sub}|${id}`); },
    async consumeQuota(sub, date, lim) {
      const used = quota.get(sub) ?? 0;
      if (used >= lim) return -1;
      quota.set(sub, used + 1);
      return lim - used - 1;
    },
  };
  const storage = {
    async presignUpload(opts) { return { url: "https://bucket.s3.amazonaws.com/", fields: { key: opts.key }, opts }; },
    async presignView({ key }) { return `https://signed/${key}`; },
    async deleteObject({ key }) { deleted.push(key); },
  };
  const verifyToken = async (token) => {
    if (token === "alice") return { sub: ALICE };
    if (token === "bob") return { sub: BOB };
    throw new Error("invalid");
  };
  const app = createApp({ verifyToken, db, storage, config: { dailyUploadLimit: limit } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, token, body) =>
    fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { call, server, jobs, deleted };
}

test("health needs no auth", async (t) => {
  const { call, server } = setup();
  t.after(() => server.close());
  const res = await call("GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("rejects missing and invalid tokens", async (t) => {
  const { call, server } = setup();
  t.after(() => server.close());
  assert.equal((await call("GET", "/api/jobs")).status, 401);
  assert.equal((await call("GET", "/api/jobs", "forged")).status, 401);
});

test("creates a job with a constrained presigned upload", async (t) => {
  const { call, server, jobs } = setup();
  t.after(() => server.close());
  const res = await call("POST", "/api/jobs", "alice", { contentType: "image/jpeg", sendEmail: true });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.upload.opts.key, new RegExp(`^uploads/${ALICE}/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(body.upload.opts.maxBytes, 5 * 1024 * 1024);
  assert.equal(body.remainingToday, 1);
  const job = jobs.get(`${ALICE}|${body.jobId}`);
  assert.equal(job.status, "PENDING");
  assert.equal(job.sendEmail, true);
});

test("validates input", async (t) => {
  const { call, server } = setup();
  t.after(() => server.close());
  assert.equal((await call("POST", "/api/jobs", "alice", { contentType: "image/gif" })).status, 400);
  assert.equal((await call("POST", "/api/jobs", "alice", { contentType: "image/png", sendEmail: "yes" })).status, 400);
  assert.equal((await call("GET", "/api/jobs/not-a-uuid", "alice")).status, 400);
});

test("enforces daily quota", async (t) => {
  const { call, server } = setup({ limit: 2 });
  t.after(() => server.close());
  for (let i = 0; i < 2; i++) {
    assert.equal((await call("POST", "/api/jobs", "alice", { contentType: "image/png" })).status, 201);
  }
  assert.equal((await call("POST", "/api/jobs", "alice", { contentType: "image/png" })).status, 429);
});

test("users cannot read or delete each other's jobs", async (t) => {
  const { call, server, deleted } = setup();
  t.after(() => server.close());
  const { jobId } = await (await call("POST", "/api/jobs", "alice", { contentType: "image/png" })).json();
  assert.equal((await call("GET", `/api/jobs/${jobId}`, "bob")).status, 404);
  assert.equal((await call("DELETE", `/api/jobs/${jobId}`, "bob")).status, 404);
  assert.deepEqual(deleted, []);
});

test("get, list and delete own job; internal fields hidden", async (t) => {
  const { call, server, deleted } = setup();
  t.after(() => server.close());
  const { jobId } = await (await call("POST", "/api/jobs", "alice", { contentType: "image/png" })).json();

  const one = await (await call("GET", `/api/jobs/${jobId}`, "alice")).json();
  assert.match(one.imageUrl, /^https:\/\/signed\/uploads\//);
  assert.equal(one.job.PK, undefined);
  assert.equal(one.job.objectKey, undefined);

  const list = await (await call("GET", "/api/jobs", "alice")).json();
  assert.equal(list.jobs.length, 1);

  assert.equal((await call("DELETE", `/api/jobs/${jobId}`, "alice")).status, 204);
  assert.equal(deleted.length, 1);
  assert.equal((await call("GET", `/api/jobs/${jobId}`, "alice")).status, 404);
});

test("unknown API route is a JSON 404", async (t) => {
  const { call, server } = setup();
  t.after(() => server.close());
  const res = await call("GET", "/api/nope", "alice");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found" });
});
