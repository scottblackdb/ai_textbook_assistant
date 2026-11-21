// Databricks auth + a tiny REST helper shared by both chat modes.
// Deployed: DATABRICKS_HOST + DATABRICKS_TOKEN.
// Local dev: host from ~/.databrickscfg, short-lived OAuth token from the CLI.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

const run = promisify(execFile);
export const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE || 'DEFAULT';

function hostFromCfg(profile) {
  const cfg = readFileSync(process.env.DATABRICKS_CONFIG_FILE || join(homedir(), '.databrickscfg'), 'utf8');
  let current = null;
  for (const raw of cfg.split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { current = sec[1]; continue; }
    const kv = line.match(/^host\s*=\s*(.+)$/);
    if (kv && current === profile) return kv[1].trim();
  }
  throw new Error(`No host found for profile "${profile}" in ~/.databrickscfg`);
}

const normalizeHost = h => (h.startsWith('http') ? h : `https://${h}`).replace(/\/+$/, '');

let cachedToken = null; // { token, expiresAt }
export async function getAuth() {
  if (process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN) {
    return { host: normalizeHost(process.env.DATABRICKS_HOST), token: process.env.DATABRICKS_TOKEN };
  }
  const host = normalizeHost(process.env.DATABRICKS_HOST || hostFromCfg(PROFILE));
  if (!cachedToken || cachedToken.expiresAt - Date.now() < 60_000) {
    const { stdout } = await run('databricks', ['auth', 'token', '--profile', PROFILE, '-o', 'json']);
    const t = JSON.parse(stdout);
    cachedToken = { token: t.access_token, expiresAt: t.expiry ? Date.parse(t.expiry) : Date.now() + 30 * 60_000 };
  }
  return { host, token: cachedToken.token };
}

/** Authenticated fetch against the workspace. `path` starts with "/". */
export async function dbFetch(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const { host, token } = await getAuth();
  return fetch(`${host}${path}`, {
    method,
    signal,
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function dbJson(path, opts) {
  const res = await dbFetch(path, opts);
  if (!res.ok) throw new Error(`${opts?.method || 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
