import { sha256Hex } from './crypto.js';
import { GateError, upsertInvoice, deleteInvoice, STATUS } from './gate.js';

export const CURRENT_PATH = 'invoices/current.json';
export const ARCHIVE_DIR  = 'invoices';
export const ARCHIVE_SIZE_BYTES = 500 * 1024;   // rotate when current.json ≥ 500 KB

/* matches new names AND any legacy month files the operator may still have */
const ARCHIVE_RE = /^(archive-[a-z0-9]+|invoices-\d{4}-\d{2})\.json$/;

const serializedBytes = obj =>
  new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n').length;

export class InvoiceService {
  constructor(store, getData) {
    this.store = store;
    this.getData = getData;              // () => state.data
    this.current = [];                   // always loaded
    this.archives = new Map();           // filename → invoices[]  (only when lazy-loaded)
    this.archiveFiles = null;            // list of archive filenames, memoized
    this.archivesLoaded = false;         // true once all archives are in memory
  }

  /* ---------------- loading ---------------- */
  async loadCurrent() {
    const { data } = await this.store.readPath(CURRENT_PATH);
    this.current = Array.isArray(data?.invoices) ? data.invoices : [];
    return this.current;
  }

  async listArchives() {
    if (this.archiveFiles) return this.archiveFiles;
    try {
      const files = await this.store.listDir(ARCHIVE_DIR);
      this.archiveFiles = files.map(f => f.name).filter(n => ARCHIVE_RE.test(n)).sort();
    } catch { this.archiveFiles = []; }
    return this.archiveFiles;
  }

  /** Lazy-load every archive file. Safe to call multiple times; a no-op when already loaded. */
  async ensureArchives() {
    if (this.archivesLoaded) return;
    const files = await this.listArchives();
    for (const name of files) {
      if (this.archives.has(name)) continue;
      try {
        const { data } = await this.store.readPath(`${ARCHIVE_DIR}/${name}`);
        this.archives.set(name, Array.isArray(data?.invoices) ? data.invoices : []);
      } catch (e) {
        console.warn(`Archive ${name} read failed:`, e.message);
      }
    }
    this.archivesLoaded = true;
  }

  /* forget archives; next ensureArchives() re-reads everything */
  resetArchives() {
    this.archives.clear();
    this.archiveFiles = null;
    this.archivesLoaded = false;
  }

  /* ---------------- queries ---------------- */
  allInvoices() {
    const seen = new Set();
    const out = [];
    const push = arr => { for (const i of arr) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); } };
    push(this.current);
    for (const [, arr] of this.archives) push(arr);
    return out;
  }

  findInvoice(id) {
    const cur = this.current.find(i => i.id === id);
    if (cur) return { inv: cur, location: 'current' };
    for (const [name, arr] of this.archives) {
      const found = arr.find(i => i.id === id);
      if (found) return { inv: found, location: 'archive', archive: name };
    }
    return null;
  }

  /* ---------------- mutations ---------------- */
  async saveInvoice(payload, actor, { submit = false } = {}) {
    if (submit) await this._syncCounterFromCurrent();

    let targetPath = CURRENT_PATH, targetArchive = null, targetLocation = 'current';
    if (payload.id) {
      const found = this.findInvoice(payload.id);
      if (!found) throw new GateError('not_found', 'فاکتور یافت نشد.');
      if (found.location === 'archive') {
        targetPath = `${ARCHIVE_DIR}/${found.archive}`;
        targetArchive = found.archive;
        targetLocation = 'archive';
      }
    }

    let captured = null;
    const result = await this.store.update((file) => {
      const invs = Array.isArray(file.invoices) ? file.invoices : [];
      const ctx = this._ctx(invs);
      captured = upsertInvoice(ctx, payload, actor, { submit });
      file.invoices = captured.data.invoices || [];
      return file;
    }, submit ? 'ثبت نهایی فاکتور' : 'ذخیره فاکتور', targetPath);

    if (targetLocation === 'archive') this.archives.set(targetArchive, result.invoices);
    else {
      this.current = result.invoices;
      await this._maybeRotateBySize();
    }

    const inv = captured?.invoice;
    if (inv && Number.isInteger(inv.number)) {
      try { await this._syncCounterTo(inv.number); }
      catch (e) { console.warn('Counter sync failed (non-fatal):', e.message); }
    }
    return { invoice: inv, deduped: !!captured?.deduped };
  }

  async deleteInvoice(payload, actor) {
    const found = this.findInvoice(payload.id);
    if (!found) throw new GateError('not_found', 'فاکتور یافت نشد.');
    const targetPath = found.location === 'archive'
      ? `${ARCHIVE_DIR}/${found.archive}` : CURRENT_PATH;

    let captured = null;
    const result = await this.store.update((file) => {
      const invs = Array.isArray(file.invoices) ? file.invoices : [];
      const ctx = this._ctx(invs);
      captured = deleteInvoice(ctx, payload, actor);
      file.invoices = captured.data.invoices || [];
      return file;
    }, 'حذف فاکتور', targetPath);

    if (found.location === 'archive') this.archives.set(found.archive, result.invoices);
    else {
      this.current = result.invoices;
      await this._maybeRotateBySize();
    }
    return { invoice: captured?.invoice };
  }

  /* ---------------- rotation by size ---------------- */
  async _maybeRotateBySize() {
    if (serializedBytes({ invoices: this.current }) < ARCHIVE_SIZE_BYTES) return null;

    /* drafts must never be archived — the cashier can only read current.json */
    const keep    = this.current.filter(i => i.status === STATUS.DRAFT);
    const archive = this.current.filter(i => i.status !== STATUS.DRAFT);
    if (archive.length === 0) return null;                   // pathological: only drafts, skip

    /* deterministic filename for idempotent retries */
    const ids  = archive.map(i => i.id).sort().join('|');
    const hash = (await sha256Hex(ids)).slice(0, 16);
    const filename = `archive-${hash}.json`;
    const archivePath = `${ARCHIVE_DIR}/${filename}`;

    /* phase 1 — write archive first, merging by id */
    let existing = { invoices: [] }, existingSha = null;
    try {
      const r = await this.store.readPath(archivePath);
      if (r?.data && Array.isArray(r.data.invoices)) { existing = r.data; existingSha = r.sha; }
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const existingIds = new Set(existing.invoices.map(i => i.id));
    const toAdd = archive.filter(i => !existingIds.has(i.id));
    if (toAdd.length > 0) {
      await this.store.writePath(
        archivePath,
        { invoices: [...existing.invoices, ...toAdd] },
        existingSha,
        `آرشیو فاکتورها (${hash.slice(0, 8)})`
      );
    }

    /* phase 2 — remove archived invoices from current.json (keep drafts) */
    const archivedIds = new Set(archive.map(i => i.id));
    await this.store.update((file) => {
      const invs = Array.isArray(file.invoices) ? file.invoices : [];
      file.invoices = invs.filter(i => !archivedIds.has(i.id));
      return file;
    }, 'چرخش آرشیو فاکتورها', CURRENT_PATH);

    /* in-memory mirror */
    this.current = keep;
    this.archives.set(filename, [...existing.invoices, ...toAdd]);
    if (this.archiveFiles && !this.archiveFiles.includes(filename)) {
      this.archiveFiles.push(filename);
      this.archiveFiles.sort();
    }
    return { archived: archive.length, path: archivePath };
  }

  /* ---------------- internals ---------------- */
  _ctx(invoices) {
    const data = this.getData() || {};
    return {
      carTypes: data.carTypes || [],
      workers: data.workers || [],
      meta: data.meta ? { ...data.meta } : {},
      invoices,
    };
  }

  async _syncCounterFromCurrent() {
    const maxCur = Math.max(0, ...this.current
      .filter(i => Number.isInteger(i.number)).map(i => i.number));
    const metaNum = Number(this.getData()?.meta?.lastInvoiceNumber || 0);
    if (maxCur > metaNum) await this._syncCounterTo(maxCur);
  }

  async _syncCounterTo(number) {
    const updated = await this.store.update(d => {
      d.meta = d.meta || {};
      if (Number(d.meta.lastInvoiceNumber || 0) < number) d.meta.lastInvoiceNumber = number;
      return d;
    }, 'همگام‌سازی شمارنده فاکتور');
    const sd = this.getData();
    if (sd) sd.meta = updated.meta || sd.meta;
    return updated;
  }
}
