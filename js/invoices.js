import { GateError, upsertInvoice, deleteInvoice, STATUS } from './gate.js';

export const CURRENT_PATH = 'invoices/current.json';
export const ARCHIVE_DIR = 'invoices';
export const ARCHIVE_SIZE_LIMIT = 500 * 1024;      // 500 KB
export const ARCHIVE_SIZE_LIMIT_LABEL = '۵۰۰ کیلوبایت';

const ARCHIVE_RE = /^archive-(\d{4})\.json$/;
const archivePath = name => `${ARCHIVE_DIR}/${name}`;
const encoder = new TextEncoder();
const byteSize = obj => encoder.encode(JSON.stringify(obj)).length;

export class InvoiceService {
  constructor(store, getData) {
    this.store = store;
    this.getData = getData;
    this.current = [];                    // current.json invoices
    this.loadedArchives = new Map();      // name → invoices[]
    this.archiveMeta = [];                // [{ name, size, sha }]
    this.listingLoaded = false;
  }

  /* ---------------- current ---------------- */
  async loadCurrent() {
    const { data } = await this.store.readPath(CURRENT_PATH);
    this.current = Array.isArray(data?.invoices) ? data.invoices : [];
    return this.current;
  }

  /* ---------------- archives (metadata is cheap; contents are lazy) ---------------- */
  async listArchives() {
    try {
      const files = await this.store.listDir(ARCHIVE_DIR);
      this.archiveMeta = files
        .filter(f => ARCHIVE_RE.test(f.name) && f.type === 'file')
        .map(f => ({ name: f.name, size: f.size || 0, sha: f.sha }))
        .sort((a, b) => a.name.localeCompare(b.name));
      this.listingLoaded = true;
    } catch {
      this.archiveMeta = [];
    }
    return this.archiveMeta;
  }

  async loadArchive(name) {
    if (this.loadedArchives.has(name)) return this.loadedArchives.get(name);
    if (!ARCHIVE_RE.test(name)) throw new GateError('archive_name', 'نام فایل بایگانی نامعتبر است.');
    const { data } = await this.store.readPath(archivePath(name));
    const invs = Array.isArray(data?.invoices) ? data.invoices : [];
    this.loadedArchives.set(name, invs);
    return invs;
  }

  isArchiveLoaded(name) { return this.loadedArchives.has(name); }

  async loadAllArchives() {
    await this.listArchives();
    await Promise.all(this.archiveMeta.map(a =>
      this.loadArchive(a.name).catch(() => [])));
  }

  /* ---------------- queries ---------------- */
  allInvoices() {
    const seen = new Set();
    const out = [];
    const push = arr => { for (const i of arr) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); } };
    push(this.current);
    for (const arr of this.loadedArchives.values()) push(arr);
    return out;
  }

  findInvoice(id) {
    const cur = this.current.find(i => i.id === id);
    if (cur) return { inv: cur, location: 'current' };
    for (const [name, arr] of this.loadedArchives) {
      const found = arr.find(i => i.id === id);
      if (found) return { inv: found, location: 'archive', name };
    }
    return null;
  }

  /* ---------------- size-based rotation ---------------- */
  currentByteSize() { return byteSize({ invoices: this.current }); }

  async maybeArchive() {
    if (this.currentByteSize() < ARCHIVE_SIZE_LIMIT) return { archived: false };

    const finalizable = this.current.filter(i => i.status !== STATUS.DRAFT);
    if (finalizable.length === 0) return { archived: false, reason: 'only-drafts' };

    if (!this.listingLoaded) await this.listArchives();
    const max = this.archiveMeta.reduce((m, f) => {
      const match = f.name.match(ARCHIVE_RE);
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const name = `archive-${String(max + 1).padStart(4, '0')}.json`;

    /* Phase 1 — write archive first (data safety) */
    await this.store.writePath(
      archivePath(name),
      { invoices: finalizable },
      null,
      `بایگانی خودکار ${name}`
    );

    /* Phase 2 — shrink current.json (drafts remain) */
    const remaining = this.current.filter(i => i.status === STATUS.DRAFT);
    const cur = await this.store.readPath(CURRENT_PATH);
    await this.store.writePath(
      CURRENT_PATH,
      { ...cur.data, invoices: remaining },
      cur.sha,
      'کوچک‌سازی فایل جاری پس از بایگانی'
    );

    this.current = remaining;
    this.loadedArchives.set(name, finalizable);
    await this.listArchives();

    return { archived: true, name, count: finalizable.length };
  }

  /* ---------------- mutations ---------------- */
  async saveInvoice(payload, actor, { submit = false } = {}) {
    if (submit) await this._syncCounterFromCurrent();

    let targetPath = CURRENT_PATH, targetName = null, targetLocation = 'current';
    if (payload.id) {
      const found = this.findInvoice(payload.id);
      if (!found) throw new GateError('not_found', 'فاکتور یافت نشد.');
      if (found.location === 'archive') {
        targetPath = archivePath(found.name);
        targetName = found.name;
        targetLocation = 'archive';
      }
    }

    let captured = null;
    const result = await this.store.update(file => {
      const invs = Array.isArray(file.invoices) ? file.invoices : [];
      const ctx = this._ctx(invs);
      captured = upsertInvoice(ctx, payload, actor, { submit });
      file.invoices = captured.data.invoices || [];
      return file;
    }, submit ? 'ثبت نهایی فاکتور' : 'ذخیره فاکتور', targetPath);

    if (targetLocation === 'archive') this.loadedArchives.set(targetName, result.invoices);
    else this.current = result.invoices;

    const inv = captured?.invoice;
    if (inv && Number.isInteger(inv.number)) {
      try { await this._syncCounterTo(inv.number); }
      catch (e) { console.warn('Counter sync failed (non-fatal):', e.message); }
    }

    let archived = null;
    if (submit) {
      try {
        const r = await this.maybeArchive();
        if (r.archived) archived = r;
      } catch (e) {
        console.warn('Archive check failed (non-fatal):', e.message);
      }
    }
    return { invoice: inv, deduped: !!captured?.deduped, archived };
  }

  async deleteInvoice(payload, actor) {
    const found = this.findInvoice(payload.id);
    if (!found) throw new GateError('not_found', 'فاکتور یافت نشد.');
    const targetPath = found.location === 'archive'
      ? archivePath(found.name) : CURRENT_PATH;

    let captured = null;
    const result = await this.store.update(file => {
      const invs = Array.isArray(file.invoices) ? file.invoices : [];
      const ctx = this._ctx(invs);
      captured = deleteInvoice(ctx, payload, actor);
      file.invoices = captured.data.invoices || [];
      return file;
    }, 'حذف فاکتور', targetPath);

    if (found.location === 'archive') this.loadedArchives.set(found.name, result.invoices);
    else this.current = result.invoices;

    return { invoice: captured?.invoice };
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
