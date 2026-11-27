import { GateError, upsertInvoice, deleteInvoice, STATUS } from './gate.js';

export const CURRENT_PATH = 'invoices/current.json';
export const ARCHIVE_DIR = 'invoices';
const ARCHIVE_RE = /^invoices-(\d{4}-\d{2})\.json$/;

export function monthKey(dateLike) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date(dateLike));
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}`;
}
export const invoiceMonth = inv => monthKey(inv.submittedAt || inv.createdAt);
const archivePath = month => `${ARCHIVE_DIR}/invoices-${month}.json`;

export class InvoiceService {
  constructor(store, getData) {
    this.store = store;
    this.getData = getData;                 // () => state.data
    this.current = [];                      // invoices from current.json
    this.archives = new Map();              // month → invoices[]
    this.loadedArchives = new Set();
    this.allArchiveMonths = null;
  }

  /* ---------------- loading ---------------- */
  async loadCurrent() {
    const { data } = await this.store.readPath(CURRENT_PATH);
    this.current = Array.isArray(data?.invoices) ? data.invoices : [];
    return this.current;
  }

  async listArchives() {
    try {
      const files = await this.store.listDir(ARCHIVE_DIR);
      this.allArchiveMonths = files
        .map(f => (String(f.name).match(ARCHIVE_RE) || [])[1])
        .filter(Boolean)
        .sort();
    } catch { this.allArchiveMonths = []; }
    return this.allArchiveMonths;
  }

  async loadArchives(months = null) {
    const targets = months || this.allArchiveMonths || (await this.listArchives());
    for (const month of targets) {
      if (this.loadedArchives.has(month)) continue;
      try {
        const { data } = await this.store.readPath(archivePath(month));
        this.archives.set(month, Array.isArray(data?.invoices) ? data.invoices : []);
        this.loadedArchives.add(month);
      } catch (e) {
        console.warn(`Archive ${month} read failed:`, e.message);
      }
    }
  }

  async loadAll() {
    await this.loadCurrent();
    await this.listArchives();
    await this.loadArchives();
  }

  /* ---------------- queries ---------------- */
  allInvoices() {
    const seen = new Set();
    const out = [];
    const push = arr => { for (const i of arr) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); } };
    push(this.current);
    for (const month of this.loadedArchives) push(this.archives.get(month) || []);
    return out;
  }

  findInvoice(id) {
    const cur = this.current.find(i => i.id === id);
    if (cur) return { inv: cur, location: 'current' };
    for (const month of this.loadedArchives) {
      const found = (this.archives.get(month) || []).find(i => i.id === id);
      if (found) return { inv: found, location: 'archive', month };
    }
    return null;
  }

  /* ---------------- rotation ---------------- */
  async rotateIfNeeded() {
    const currentMonth = monthKey(new Date());
    const keep = [];
    const toArchive = new Map();

    for (const inv of this.current) {
      if (inv.status === STATUS.DRAFT) { keep.push(inv); continue; }   // drafts stay editable
      const m = invoiceMonth(inv);
      if (m === currentMonth) { keep.push(inv); continue; }
      if (!toArchive.has(m)) toArchive.set(m, []);
      toArchive.get(m).push(inv);
    }
    if (toArchive.size === 0) return { rotated: 0 };

    /* Phase 1: write all archives first — idempotent (dedupe by id) */
    for (const [month, invs] of toArchive) {
      const path = archivePath(month);
      let existing = { invoices: [] }, sha = null;
      try {
        const r = await this.store.readPath(path);
        if (r?.data && Array.isArray(r.data.invoices)) { existing = r.data; sha = r.sha; }
      } catch (e) {
        if (e.status !== 404)
          throw new GateError('archive_read', `خواندن آرشیو ${month} ناموفق بود: ${e.message}`);
      }
      const existingIds = new Set(existing.invoices.map(i => i.id));
      const toAdd = invs.filter(i => !existingIds.has(i.id));
      if (toAdd.length === 0) continue;
      await this.store.writePath(
        path,
        { ...existing, invoices: [...existing.invoices, ...toAdd] },
        sha,
        `آرشیو فاکتورهای ${month}`
      );
    }

    /* Phase 2: only after every archive write succeeded, shrink current.json */
    const cur = await this.store.readPath(CURRENT_PATH);
    const curInvs = Array.isArray(cur.data?.invoices) ? cur.data.invoices : [];
    const remaining = curInvs.filter(inv => inv.status === STATUS.DRAFT || invoiceMonth(inv) === currentMonth);
    if (remaining.length !== curInvs.length) {
      await this.store.writePath(CURRENT_PATH, { ...cur.data, invoices: remaining },
                                 cur.sha, 'چرخش ماهانه فاکتورها');
    }
    this.current = remaining;

    for (const month of toArchive.keys()) {
      this.loadedArchives.delete(month);
      this.archives.delete(month);
    }
    await this.loadArchives([...toArchive.keys()]);
    return { rotated: toArchive.size };
  }

  /* ---------------- mutations ---------------- */
  async saveInvoice(payload, actor, { submit = false } = {}) {
    // Ensure counter reflects reality before submit assigns a new number
    if (submit) await this._syncCounterFromCurrent();

    let targetPath = CURRENT_PATH, targetMonth = null, targetLocation = 'current';
    if (payload.id) {
      const found = this.findInvoice(payload.id);
      if (!found) throw new GateError('not_found', 'فاکتور یافت نشد.');
      if (found.location === 'archive') {
        targetPath = archivePath(found.month);
        targetMonth = found.month;
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

    if (targetLocation === 'archive') this.archives.set(targetMonth, result.invoices);
    else this.current = result.invoices;

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
      ? archivePath(found.month)
      : CURRENT_PATH;

    let captured = null;
    const result = await this.store.update((file) => {
      const invs = Array.isArray(file.invoices) ? file.invoices : [];
      const ctx = this._ctx(invs);
      captured = deleteInvoice(ctx, payload, actor);
      file.invoices = captured.data.invoices || [];
      return file;
    }, 'حذف فاکتور', targetPath);

    if (found.location === 'archive') this.archives.set(found.month, result.invoices);
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
