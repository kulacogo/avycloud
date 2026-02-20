const { GoogleAuth } = require('google-auth-library');

const RUN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function buildJobName({ name, projectId, location, jobId }) {
  const n = safeString(name);
  if (n) return n;
  const p = safeString(projectId);
  const loc = safeString(location);
  const j = safeString(jobId);
  if (!p || !loc || !j) return '';
  return `projects/${p}/locations/${loc}/jobs/${j}`;
}

async function runCloudRunJob({
  name = '',
  projectId = '',
  location = '',
  jobId = '',
  overrides = null,
  validateOnly = false,
} = {}) {
  const jobName = buildJobName({ name, projectId, location, jobId });
  if (!jobName) {
    throw new Error(
      'Missing Cloud Run Job config. Provide either full name (projects/{project}/locations/{location}/jobs/{job}) or projectId+location+jobId.'
    );
  }

  const auth = new GoogleAuth({ scopes: [RUN_SCOPE] });
  const headers = await auth.getRequestHeaders();

  const url = `https://run.googleapis.com/v2/${encodeURIComponent(jobName)}:run`.replace(
    /%2F/g,
    '/'
  );

  const body = {};
  if (validateOnly) body.validateOnly = true;
  if (overrides && typeof overrides === 'object') body.overrides = overrides;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      text?.slice(0, 500) ||
      `Cloud Run Job run failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json || {};
}

async function getCloudRunOperation({ name = '' } = {}) {
  const opName = safeString(name);
  if (!opName) throw new Error('Missing operation name');
  if (!opName.startsWith('projects/')) throw new Error('Operation name must be full resource name (projects/...)');

  const auth = new GoogleAuth({ scopes: [RUN_SCOPE] });
  const headers = await auth.getRequestHeaders();

  const url = `https://run.googleapis.com/v2/${encodeURIComponent(opName)}`.replace(/%2F/g, '/');
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      text?.slice(0, 500) ||
      `Cloud Run operation fetch failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json || {};
}

module.exports = {
  runCloudRunJob,
  getCloudRunOperation,
};

