import { bytesToB64, b64ToBytes } from './crypto.js';

const API = 'https://api.github.com';

async function errText(res) {
  try { const j = await res.json(); return j.message || res.statusText; }
  catch { return res.statusText || `HTTP ${res.status}`; }
}

export class GitHubStore {
  constructor({ owner, repo, branch = 'main', path = 'data.json', token }) {
    Object.assign(this, { owner, repo, branch, path, token });
  }

  _url(p) { return `${API}/repos/${this.owner}/${this.repo}/contents/${p}`; }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  /** Read any path. Returns { data, sha } or { data: null, sha: null } on 404. */
  async readPath(path) {
    const res = await fetch(
      `${this._url(path)}?ref=${encodeURIComponent(this.branch)}&t=${Date.now()}`,
      { headers: this.headers(), cache: 'no-store' }
    );
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) { const e = new Error(await errText(res)); e.status = res.status; throw e; }
    const j = await res.json();
    const text = new TextDecoder().decode(b64ToBytes(j.content.replace(/\s/g, '')));
    return { data: JSON.parse(text), sha: j.sha };
  }

  /** Write any path. */
  async writePath(path, data, sha, message) {
    const content = bytesToB64(new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n'));
    const body = { message, content, branch: this.branch };
    if (sha) body.sha = sha;
    const res = await fetch(this._url(path), {
      method: 'PUT', headers: this.headers(), body: JSON.stringify(body),
    });
    if (!res.ok) { const e = new Error(await errText(res)); e.status = res.status; throw e; }
    return res.json();
  }

  /** List a directory. Returns [] if missing or not a directory. */
  async listDir(dir) {
    const res = await fetch(
      `${this._url(dir)}?ref=${encodeURIComponent(this.branch)}&t=${Date.now()}`,
      { headers: this.headers(), cache: 'no-store' }
    );
    if (res.status === 404) return [];
    if (!res.ok) { const e = new Error(await errText(res)); e.status = res.status; throw e; }
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  }

  /* Legacy helpers — same behavior as before, now with `path` param */
  async read() { return this.readPath(this.path); }
  async write(data, sha, message) { return this.writePath(this.path, data, sha, message); }

  async update(mutator, message, path = this.path) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await this.readPath(path);
      const base = data || { meta: {}, users: [], carTypes: [], workers: [], invoices: [] };
      const next = await mutator(structuredClone(base));
      try {
        await this.writePath(path, next, sha, message);
        return next;
      } catch (e) {
        lastErr = e;
        if (e.status === 409 || e.status === 422) {
          await new Promise(r => setTimeout(r, 300 + attempt * 500));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}
