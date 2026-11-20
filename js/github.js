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

  get url() {
    return `${API}/repos/${this.owner}/${this.repo}/contents/${this.path}`;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  async read() {
    const res = await fetch(
      `${this.url}?ref=${encodeURIComponent(this.branch)}&t=${Date.now()}`,
      { headers: this.headers(), cache: 'no-store' }
    );
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error(await errText(res));
    const j = await res.json();
    const text = new TextDecoder().decode(b64ToBytes(j.content.replace(/\s/g, '')));
    return { data: JSON.parse(text), sha: j.sha };
  }

  async write(data, sha, message) {
    const content = bytesToB64(new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n'));
    const body = { message, content, branch: this.branch };
    if (sha) body.sha = sha;

    const res = await fetch(this.url, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(await errText(res));
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Read → mutate → write, retrying on concurrent-update conflicts. */
  async update(mutator, message) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await this.read();
      const base = data || { meta: {}, users: [], carTypes: [], workers: [], invoices: [] };
      const next = await mutator(structuredClone(base));
      try {
        await this.write(next, sha, message);
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