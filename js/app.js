import { sha256Hex, decryptToken } from './crypto.js';
import { GitHubStore } from './github.js';
import { InvoiceService, CURRENT_PATH } from './invoices.js';
import {
  toJalaali, toGregorian, jalaaliMonthLength, JALALI_MONTHS,
} from './jalali.js';
import {
  GateError, computeTotal, computeSubtotal, SERVICE_NAMES, STATUS, ROLES,
} from './gate.js';

/* ================= helpers ================= */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* ---------------- Tehran (IRST / UTC+3:30) time helpers ---------------- */
const TEHRAN_TZ = 'Asia/Tehran';
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;   // Iran has no DST since 2022

/** Gregorian calendar parts of `date` as seen in Tehran. */
function tehranGregorianParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TEHRAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = t => Number(parts.find(p => p.type === t)?.value);
  return { gy: get('year'), gm: get('month'), gd: get('day') };
}

/** Jalali (jy, jm, jd) of `date` as seen in Tehran. */
function tehranJalali(date = new Date()) {
  const p = tehranGregorianParts(date);
  return toJalaali(p.gy, p.gm, p.gd);
}

/** Milliseconds for Tehran's [00:00:00.000, 23:59:59.999] of a Gregorian day. */
const tehranDayStartMs = (gy, gm, gd) => Date.UTC(gy, gm - 1, gd, 0, 0, 0, 0) - TEHRAN_OFFSET_MS;
const tehranDayEndMs   = (gy, gm, gd) => Date.UTC(gy, gm - 1, gd, 23, 59, 59, 999) - TEHRAN_OFFSET_MS;

/* ---------------- display / filter formatters (now Tehran-based) ---------------- */
const fmt = n => Number(n || 0).toLocaleString('fa-IR');
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : uid('key'));

/** ISO date (YYYY-MM-DD) in Tehran time — used for report filtering. */
const isoDate = v => {
  const p = tehranGregorianParts(v);
  const pad = n => String(n).padStart(2, '0');
  return `${p.gy}-${pad(p.gm)}-${pad(p.gd)}`;
};
const todayISO = () => isoDate(new Date());

/** Jalali date + time in Tehran time — used for display only. */
const faDate = v => new Date(v).toLocaleDateString('fa-IR', { timeZone: TEHRAN_TZ });
const faTime = v => new Date(v).toLocaleTimeString('fa-IR', {
  timeZone: TEHRAN_TZ, hour: '2-digit', minute: '2-digit',
});

/** Display-date source: submittedAt if present, else createdAt. */
const invDate = inv => inv.submittedAt ?? inv.createdAt;

/** Sort key: actual ms timestamp of invDate — NOT the formatted string. */
const invTs = inv => {
  const v = invDate(inv);
  return v ? new Date(v).getTime() : 0;
};

const state = {
  workerReport: null, data: null, user: null, store: null,
  invoiceService: null,                          // ← NEW
  route: { name: 'login' },
  draft: null, report: null, filter: 'all',
  busy: false, error: '', toast: '',
};

const isManager = () => state.user && state.user.role === ROLES.MANAGER;
const homeRoute = () => (isManager() ? 'manager' : 'cashierhome');
const actor = () => ({ username: state.user.username, role: state.user.role });

function newDraft() {
  return {
    id: null, idempotencyKey: uuid(), status: STATUS.DRAFT, number: null,
    customer: '', carTypeId: '', carId: '', workerId: '',
    services: { wash: true, vacuum: false, wax: false },
    extras: [], tip: 0, discount: 0,
  };
}

function draftFromInvoice(inv) {
  return {
    id: inv.id,
    idempotencyKey: inv.idempotencyKey || uuid(),
    status: inv.status,
    number: inv.number || null,
    customer: inv.customer || '',
    carTypeId: inv.carTypeId || '',
    carId: inv.carId || '',
    workerId: inv.workerId || '',
    services: {
      wash: !!(inv.services && inv.services.wash),
      vacuum: !!(inv.services && inv.services.vacuum),
      wax: !!(inv.services && inv.services.wax),
    },
    extras: (inv.extras || []).map(x => ({ desc: x.desc || '', amount: Number(x.amount || 0) })),
    tip: Number(inv.tip || 0),
    discount: Number(inv.discount || 0),
  };
}

async function loadJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`خواندن ${path} ناموفق بود (${res.status})`);
  return res.json();
}

/* ================= login ================= */
async function doLogin(username, password) {
  const data = await loadJson('data.json');
  const user = (data.users || []).find(
    u => String(u.username).toLowerCase() === String(username).trim().toLowerCase());
  if (!user) throw new Error('نام کاربری یا رمز ورود نادرست است.');
  const hash = (await sha256Hex(password)).toLowerCase();
  if (hash !== String(user.passHash || '').toLowerCase())
    throw new Error('نام کاربری یا رمز ورود نادرست است.');

  const secrets = await loadJson('secrets.json');
  const rec = secrets.users && secrets.users[user.username];
  if (!rec) throw new Error('کلید رمزگشایی برای این کاربر تنظیم نشده است.');

  let token;
  try { token = await decryptToken(rec, password); }
  catch { throw new Error('رمزگشایی توکن ناموفق بود.'); }

  state.user = user;
  state.data = data;
  state.store = new GitHubStore({ ...secrets.repo, token });
  state.invoiceService = new InvoiceService(state.store, () => state.data);

  /* Load current invoices, then auto-rotate, then (for manager) load archives */
  await state.invoiceService.loadCurrent();
  const { rotated } = await state.invoiceService.rotateIfNeeded();
  if (user.role === ROLES.MANAGER) await state.invoiceService.loadAll();

  state.draft = newDraft();
  state.route = { name: user.role === ROLES.MANAGER ? 'manager' : 'cashierhome' };
  if (user.role === ROLES.MANAGER) {
    state.workerReport = defaultWorkerReport();
  }
  state.error = '';
  if (rotated > 0) state.toast = `${fmt(rotated)} ماه آرشیو شد.`;
}

async function runInvoiceOp(fn, successMessage) {
  if (state.busy) return null;
  state.busy = true;
  state.error = '';
  render();
  try {
    const result = await fn();
    // Keep data.json's counter in sync with the invoice we just wrote
    const inv = result?.invoice;
    if (inv && Number.isInteger(inv.number)) {
      const curMeta = Number(state.data.meta?.lastInvoiceNumber || 0);
      if (inv.number > curMeta) {
        state.data.meta = state.data.meta || {};
        state.data.meta.lastInvoiceNumber = inv.number;
      }
    }
    state.toast = typeof successMessage === 'function'
      ? successMessage(result) : successMessage;
    return result;
  } catch (e) {
    state.error = e instanceof GateError
      ? e.message
      : ('ذخیره‌سازی ناموفق بود: ' + (e?.message || 'خطای نامشخص'));
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

/* ================= the only write path ================= */
async function runOp(op, commitMessage, successMessage) {
  if (state.busy) return null;                       // feature 3: no re-entry
  state.busy = true;
  state.error = '';
  render();
  let captured = null;
  try {
    state.data = await state.store.update(d => {
      const out = op(d);
      captured = out;
      return out && out.data ? out.data : out;
    }, commitMessage);
    state.toast = typeof successMessage === 'function'
      ? successMessage(captured) : (successMessage || commitMessage);
    return captured;
  } catch (e) {
    state.error = e instanceof GateError
      ? e.message
      : ('ذخیره‌سازی ناموفق بود: ' + (e && e.message ? e.message : 'خطای نامشخص'));
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

/* ================= totals ================= */
function previewTotal(d) {
  const type = (state.data.carTypes || []).find(t => t.id === d.carTypeId);
  const pr = (type && type.prices) || {};
  return computeTotal({
    services: d.services,
    prices: { wash: Number(pr.wash || 0), vacuum: Number(pr.vacuum || 0), wax: Number(pr.wax || 0) },
    extras: d.extras,
    tip: Number(d.tip || 0),
    discount: Number(d.discount || 0),
  });
}

function refreshTotal() {
  const el = document.getElementById('invoice-total');
  if (el && state.draft) el.textContent = fmt(previewTotal(state.draft));
}

/* ================= reports ================= */
function makeJalaliPicker(which, val, disabled = false) {
  const max = jalaaliMonthLength(val.jy, val.jm);
  const d = disabled ? 'disabled' : '';
  const yearOptions = (sel) => {
    const cy = tehranJalali().jy;
    let out = '';
    for (let y = cy - 3; y <= cy + 1; y++)
      out += `<option value="${y}" ${sel === y ? 'selected' : ''}>${y}</option>`;
    return out;
  };
  const monthOptions = (sel) => JALALI_MONTHS
    .map((name, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${name}</option>`)
    .join('');
  const dayOptions = (sel, max) => {
    let out = '';
    for (let d = 1; d <= max; d++)
      out += `<option value="${d}" ${sel === d ? 'selected' : ''}>${d}</option>`;
    return out;
  };
  return `
    <div class="jalali-picker">
      <select data-jalali="${which}" data-part="jd" ${d}>${dayOptions(val.jd, max)}</select>
      <select data-jalali="${which}" data-part="jm" ${d}>${monthOptions(val.jm)}</select>
      <select data-jalali="${which}" data-part="jy" ${d}>${yearOptions(val.jy)}</select>
    </div>`;
}

function defaultWorkerReport() {
  const t = tehranJalali();
  return {
    start: { jy: t.jy, jm: t.jm, jd: 1 },   // 1st of current Jalali month
    end:   { jy: t.jy, jm: t.jm, jd: t.jd }, // today
    loading: false, error: '', result: null,
  };
}

function defaultReport() {
  const t = tehranJalali();
  return {
    start: { jy: t.jy, jm: t.jm, jd: 1 },     // 1st of current Jalali month
    end:   { jy: t.jy, jm: t.jm, jd: t.jd },  // today
    workerIds: null, result: null,
  };
}

function dailyReport(day) {
  const all = state.invoiceService ? state.invoiceService.allInvoices() : [];
  const rows = new Map((state.data.workers || []).map(w => [w.id, { id: w.id, name: w.name, count: 0, total: 0, tips: 0 }]));
  let count = 0, total = 0, tips = 0;
  for (const inv of all) {
    if (inv.status !== STATUS.SUBMITTED) continue;
    if (isoDate(inv.submittedAt || inv.createdAt) !== day) continue;
    const t = Number(inv.total || 0), p = Number(inv.tip || 0);
    count++; total += t; tips += p;
    const r = rows.get(inv.workerId);
    if (r) { r.count++; r.total += t; r.tips += p; }
    else rows.set(inv.workerId, { id: inv.workerId, name: inv.workerName || 'کارگر حذف‌شده', count: 1, total: t, tips: p });
  }
  return { rows: [...rows.values()], count, total, tips };
}

function computeReport({ start, end, workerIds }) {
  const all = state.invoiceService ? state.invoiceService.allInvoices() : [];
  const set = new Set(workerIds);
  const invoices = all.filter(inv => {
    if (inv.status !== STATUS.SUBMITTED) return false;
    const d = isoDate(inv.submittedAt || inv.createdAt);
    if (start && d < start) return false;
    if (end && d > end) return false;
    if (set.size && !set.has(inv.workerId)) return false;
    return true;
  });
  return {
    invoices,
    count: invoices.length,
    total: invoices.reduce((s, i) => s + Number(i.total || 0), 0),
    tips: invoices.reduce((s, i) => s + Number(i.tip || 0), 0),
  };
}

function servicesLabel(inv) {
  const names = [];
  for (const k of ['wash', 'vacuum', 'wax']) if (inv.services && inv.services[k]) names.push(SERVICE_NAMES[k]);
  (inv.extras || []).forEach(x => names.push(`${x.desc || 'متفرقه'}${x.amount ? ` (${fmt(x.amount)})` : ''}`));
  return names.join('، ') || '—';
}

/* ================= layout ================= */
function layout(title, body, back) {
  return `
  <header class="topbar">
    <span class="brand">کارواش آفرینش</span>
    <span class="spacer"></span>
    <span class="who">${esc(state.user.username)} · ${isManager() ? 'مدیر' : 'صندوق‌دار'}</span>
    <button class="btn ghost" type="button" data-action="logout" ${state.busy ? 'disabled' : ''}>خروج</button>
  </header>
  <div class="content">
    <div class="pagehead">
      <h2>${esc(title)}</h2>
      ${back ? `<button class="btn ghost" type="button" data-action="go" data-route="${back}" ${state.busy ? 'disabled' : ''}>بازگشت</button>` : ''}
    </div>
    ${state.error ? `<div class="alert error">${esc(state.error)}</div>` : ''}
    ${body}
  </div>`;
}

/* ================= views: auth ================= */
function viewLogin() {
  return `
  <div class="login-wrap">
    <form class="card login" data-form="login">
      <h1>کارواش آفرینش</h1>
      <p class="muted">به کارواش آفرینش خوش آمدید.</p>
      <label class="field">نام کاربری<input name="username" required autocomplete="username" dir="ltr"></label>
      <label class="field">رمز ورود<input name="password" type="password" required autocomplete="current-password" dir="ltr"></label>
      ${state.error ? `<p class="alert error">${esc(state.error)}</p>` : ''}
      <button class="btn primary block" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span>در حال ورود…' : 'ورود'}</button>
    </form>
  </div>`;
}

/* ================= views: manager ================= */
function viewManagerHome() {
  return layout('منوی مدیر', `
    <div class="grid">
      <button class="tile" type="button" data-action="go" data-route="cars">مدیریت خودروها</button>
      <button class="tile" type="button" data-action="go" data-route="tariffs">تنظیم تعرفه‌ها</button>
      <button class="tile" type="button" data-action="go" data-route="workers">فهرست کارگران</button>
      <button class="tile" type="button" data-action="go" data-route="invoices">فاکتورها</button>
      <button class="tile" type="button" data-action="go" data-route="reports">گزارش کارکرد</button>
      <button class="tile" type="button" data-action="go" data-route="worker-report">گزارش کارگران</button>
      <button class="tile" type="button" data-action="new-invoice">ثبت فاکتور</button>
    </div>`);
}

function viewCars() {
  const types = state.data.carTypes || [];
  const busy = state.busy ? 'disabled' : '';
  const list = types.length ? types.map((t, i) => `
    <li class="row">
      <button class="link" type="button" data-action="open-type" data-id="${t.id}">${esc(t.name)}</button>
      <span class="muted">${fmt((t.cars || []).length)} خودرو</span>
      <span class="grow"></span>
      <button class="btn icon" type="button" data-action="move-type" data-id="${t.id}" data-dir="-1" ${i === 0 || busy ? 'disabled' : ''}>▲</button>
      <button class="btn icon" type="button" data-action="move-type" data-id="${t.id}" data-dir="1" ${i === types.length - 1 || busy ? 'disabled' : ''}>▼</button>
      <button class="btn danger" type="button" data-action="remove-type" data-id="${t.id}" ${busy}>حذف</button>
    </li>`).join('') : '<li class="empty">گروهی ثبت نشده است.</li>';

  return layout('مدیریت خودروها', `
    <ul class="list">${list}</ul>
    <form class="card" data-form="add-type">
      <h3>افزودن گروه</h3>
      <div class="inline">
        <input name="name" placeholder="نام گروه خودرو" required ${busy}>
        <button class="btn primary" type="submit" ${busy}>افزودن</button>
      </div>
    </form>`, 'manager');
}

function viewCarType(typeId) {
  const type = (state.data.carTypes || []).find(t => t.id === typeId);
  if (!type) return layout('گروه خودرو', '<p class="muted">گروه یافت نشد.</p>', 'cars');
  const busy = state.busy ? 'disabled' : '';
  const cars = type.cars || [];
  const list = cars.length ? cars.map((c, i) => `
    <li class="row">
      <span>${esc(c.name)}</span>
      <span class="grow"></span>
      <button class="btn icon" type="button" data-action="move-car" data-type="${type.id}" data-id="${c.id}" data-dir="-1" ${i === 0 || busy ? 'disabled' : ''}>▲</button>
      <button class="btn icon" type="button" data-action="move-car" data-type="${type.id}" data-id="${c.id}" data-dir="1" ${i === cars.length - 1 || busy ? 'disabled' : ''}>▼</button>
      <button class="btn danger" type="button" data-action="remove-car" data-type="${type.id}" data-id="${c.id}" ${busy}>حذف</button>
    </li>`).join('') : '<li class="empty">خودرویی ثبت نشده است.</li>';

  return layout(`خودروهای ${type.name}`, `
    <ul class="list">${list}</ul>
    <form class="card" data-form="add-car" data-id="${type.id}">
      <h3>افزودن خودرو</h3>
      <div class="inline">
        <input name="name" placeholder="نام خودرو" required ${busy}>
        <button class="btn primary" type="submit" ${busy}>افزودن</button>
      </div>
    </form>`, 'cars');
}

function viewTariffs() {
  const types = state.data.carTypes || [];
  const list = types.length ? types.map(t => `
    <li class="row">
      <button class="link" type="button" data-action="open-tariff" data-id="${t.id}">${esc(t.name)}</button>
      <span class="grow"></span>
      <span class="muted">روشویی ${fmt(t.prices?.wash)} · جارو ${fmt(t.prices?.vacuum)} · واکس ${fmt(t.prices?.wax)}</span>
    </li>`).join('') : '<li class="empty">گروهی ثبت نشده است.</li>';
  return layout('تنظیم تعرفه‌ها', `<ul class="list">${list}</ul>`, 'manager');
}

function viewTariff(typeId) {
  const type = (state.data.carTypes || []).find(t => t.id === typeId);
  if (!type) return layout('تعرفه‌ها', '<p class="muted">گروه یافت نشد.</p>', 'tariffs');
  const p = type.prices || {};
  const busy = state.busy ? 'disabled' : '';
  return layout(`تعرفه‌های ${type.name}`, `
    <form class="card" data-form="tariff" data-id="${type.id}">
      <label class="field">روشویی (تومان)<input type="number" min="0" step="1" name="wash" value="${Number(p.wash || 0)}" ${busy}></label>
      <label class="field">جارو (تومان)<input type="number" min="0" step="1" name="vacuum" value="${Number(p.vacuum || 0)}" ${busy}></label>
      <label class="field">واکس داشبورد (تومان)<input type="number" min="0" step="1" name="wax" value="${Number(p.wax || 0)}" ${busy}></label>
      <button class="btn primary block" type="submit" ${busy}>${busy ? '<span class="spinner"></span>در حال ذخیره…' : 'ذخیره تعرفه‌ها'}</button>
    </form>`, 'tariffs');
}

function viewWorkers() {
  const workers = state.data.workers || [];
  const busy = state.busy ? 'disabled' : '';
  const list = workers.length ? workers.map(w => `
    <li class="row">
      <form class="inline grow" data-form="rename-worker" data-id="${w.id}">
        <input name="name" value="${esc(w.name)}" required ${busy}>
        <button class="btn" type="submit" ${busy}>ذخیره نام</button>
      </form>
      <button class="btn danger" type="button" data-action="remove-worker" data-id="${w.id}" ${busy}>حذف</button>
    </li>`).join('') : '<li class="empty">کارگری ثبت نشده است.</li>';

  return layout('فهرست کارگران', `
    <ul class="list">${list}</ul>
    <form class="card" data-form="add-worker">
      <h3>افزودن کارگر</h3>
      <div class="inline">
        <input name="name" placeholder="نام کارگر" required ${busy}>
        <button class="btn primary" type="submit" ${busy}>افزودن</button>
      </div>
    </form>`, 'manager');
}

function viewReports() {
  const workers = state.data.workers || [];
  if (!state.report) state.report = defaultReport();          // ← new
  const r = state.report;
  if (!r.workerIds) r.workerIds = workers.map(w => w.id);      // ← new
  const selected = new Set(r.workerIds);
  const busy = state.busy ? 'disabled' : '';

  const checks = workers.map(w => `
    <label class="check">
      <input type="checkbox" name="worker" value="${w.id}" ${selected.has(w.id) ? 'checked' : ''} ${busy}>
      ${esc(w.name)}
    </label>`).join('') || '<p class="muted">کارگری ثبت نشده است.</p>';

  let resultHtml = '';
  if (r.result) {
    const sortedInvoices = [...r.result.invoices].sort((a, b) => invTs(b) - invTs(a));
    const rows = sortedInvoices.length ? sortedInvoices.map(inv => `
      <tr>
        <td>${inv.number ? '#' + fmt(inv.number) : '—'}</td>
        <td>${faDate(invDate(inv))}</td>
        <td>${faTime(invDate(inv))}</td>
        <td>${esc(inv.customer || '—')}</td>
        <td>${esc(inv.carTypeName || '—')} / ${esc(inv.carName || '—')}</td>
        <td>${esc(inv.workerName || '—')}</td>
        <td>${esc(servicesLabel(inv))}</td>
        <td>${fmt(inv.tip)}</td>
        <td>${fmt(inv.discount)}</td>
        <td><strong>${fmt(inv.total)}</strong></td>
      </tr>`).join('')
      : '<tr><td colspan="10" class="empty">فاکتور نهایی‌شده‌ای در این بازه یافت نشد.</td></tr>';

    resultHtml = `
      <div class="card">
        <div class="stats">
          <div class="stat"><span class="num">${fmt(r.result.count)}</span><span>تعداد خودرو</span></div>
          <div class="stat"><span class="num">${fmt(r.result.total)}</span><span>جمع کل (تومان)</span></div>
          <div class="stat"><span class="num">${fmt(r.result.tips)}</span><span>جمع انعام (تومان)</span></div>
        </div>
      </div>
      <div class="card">
        <h3>فهرست فاکتورها</h3>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>شماره</th><th>تاریخ</th><th>ساعت</th><th>مشتری</th><th>خودرو</th>
              <th>کارگر</th><th>خدمات</th><th>انعام</th><th>تخفیف</th><th>مبلغ کل</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  return layout('گزارش کارکرد', `
    <form class="card" data-form="report">
      <div class="grid2">
        <label class="field">از تاریخ ${makeJalaliPicker('start', r.start, !!busy)}</label>
        <label class="field">تا تاریخ ${makeJalaliPicker('end',   r.end,   !!busy)}</label>
      </div>
      <fieldset>
        <legend>کارگران (خالی = همه)</legend>
        ${checks}
      </fieldset>
      <button class="btn primary block" type="submit" ${busy}>نمایش گزارش</button>
    </form>
    ${resultHtml}`, 'manager');
}
  

/* ================= views: invoices (shared, role-aware) ================= */
function invoiceRow(inv, manager) {
  const badgeMap = {
    [STATUS.DRAFT]: ['draft', 'پیش فاکتور'],
    [STATUS.SUBMITTED]: ['submitted', 'نهایی'],
    [STATUS.VOID]: ['void', 'حذف‌شده'],
  };
  const [cls, label] = badgeMap[inv.status] || ['draft', inv.status];
  const busy = state.busy ? 'disabled' : '';

  const actions = [];
  if (inv.status === STATUS.DRAFT)
    actions.push(`<button class="btn" type="button" data-action="open-invoice" data-id="${inv.id}" ${busy}>ادامه / ویرایش</button>`);
  if (manager && inv.status === STATUS.SUBMITTED)
    actions.push(`<button class="btn" type="button" data-action="open-invoice" data-id="${inv.id}" ${busy}>ویرایش</button>`);
  if (manager && inv.status !== STATUS.VOID)
    actions.push(`<button class="btn danger" type="button" data-action="delete-invoice" data-id="${inv.id}" ${busy}>حذف</button>`);

  return `
  <li class="row inv">
    <div class="inv-main">
      <div class="inv-line">
        <span class="badge ${cls}">${label}</span>
        ${inv.number ? `<span class="inv-num">فاکتور #${fmt(inv.number)}</span>` : ''}
        <span>${esc(inv.customer) || 'بدون نام'}</span>
        <span class="muted">${esc(inv.carTypeName || '—')} / ${esc(inv.carName || '—')}</span>
        <span class="muted">${esc(inv.workerName || 'کارگر تعیین نشده')}</span>
        <span class="grow"></span>
        <strong>${fmt(inv.total)} تومان</strong>
      </div>
      <div class="inv-line muted">
        <span>${faDate(invDate(inv))} ${faTime(invDate(inv))}</span>   <!-- was: inv.createdAt ×2 -->
        <span>${esc(servicesLabel(inv))}</span>
        ${inv.status === STATUS.VOID ? `<span>حذف: ${faDate(inv.deletedAt)} توسط ${esc(inv.deletedBy || '—')}</span>` : ''}
      </div>
    </div>
    <div class="inv-actions">${actions.join('')}</div>
  </li>`;
}

function viewInvoices() {
  const manager = isManager();
  const filter = manager ? (state.filter || 'all') : STATUS.DRAFT;
  const all = state.invoiceService ? state.invoiceService.allInvoices() : [];
  const visible = manager ? all : all.filter(i => i.status === STATUS.DRAFT);

  const sorted = [...visible].sort((a, b) => invTs(b) - invTs(a));   // was: localeCompare on createdAt

  const filters = manager
    ? [['all', 'همه'], ['draft', 'پیش‌فاکتور'], ['submitted', 'نهایی'], ['void', 'حذف‌شده']]
    : [['draft', 'پیش‌فاکتور']];

  const list = sorted.filter(inv => filter === 'all' ? inv.status !== STATUS.VOID : inv.status === filter);
  const items = list.length
    ? list.map(inv => invoiceRow(inv, manager)).join('')
    : `<li class="empty">${manager ? 'موردی یافت نشد.' : 'پیش‌فاکتوری وجود ندارد.'}</li>`;
  const busy = state.busy ? 'disabled' : '';
  const title = manager ? 'فاکتورها و پیش‌فاکتورها' : 'پیش‌فاکتورها';

  return layout(title, `
    <div class="toolbar">
      ${filters.map(([v, l]) => `<button class="btn ${filter === v ? 'active' : ''}" type="button" data-action="filter" data-value="${v}">${l}</button>`).join('')}
      <span class="grow"></span>
      <button class="btn" type="button" data-action="refresh" ${busy}>به‌روزرسانی</button>
      <button class="btn primary" type="button" data-action="new-invoice" ${busy}>فاکتور جدید</button>
    </div>
    <ul class="list">${items}</ul>`, homeRoute());
}

function viewWorkerReport() {
  const w = state.workerReport;
  if (!w) return layout('گزارش کارگران', '<p class="muted">داده‌ای موجود نیست.</p>', 'manager');

  const busy = state.busy || w.loading;

  let body;
  if (w.loading) {
    body = `<div class="card empty"><span class="spinner"></span>در حال بارگذاری گزارش…</div>`;
  } else if (w.error) {
    body = `<div class="alert error">${esc(w.error)}</div>`;
  } else if (w.result) {
    if (w.result.rows.length === 0) {
      body = `<div class="card empty">در این بازه تاریخی کاری ثبت نشده است.</div>`;
    } else {
      const rowsHtml = w.result.rows.map(r => `
        <tr>
          <td>${esc(r.name)}</td>
          <td>${fmt(r.jobs)}</td>
          <td>${fmt(r.tips)} <span class="muted">تومان</span></td>
          <td><strong>${fmt(r.sum)}</strong> <span class="muted">تومان</span></td>
        </tr>`).join('');
      body = `
        <div class="card">
          <div class="table-wrap">
            <table class="report-table">
              <thead>
                <tr>
                  <th>نام کارگر</th>
                  <th>تعداد کار</th>
                  <th>جمع انعام</th>
                  <th>جمع کل</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
              <tfoot>
                <tr>
                  <td>جمع کل</td>
                  <td>${fmt(w.result.totals.jobs)}</td>
                  <td>${fmt(w.result.totals.tips)} <span class="muted">تومان</span></td>
                  <td>${fmt(w.result.totals.sum)} <span class="muted">تومان</span></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>`;
    }
  } else {
    body = `<div class="card empty">برای مشاهده گزارش، بازه را انتخاب و «نمایش گزارش» را بزنید.</div>`;
  }

  return layout('گزارش کارگران', `
    <div class="card">
      <div class="grid2">
        <label class="field">از تاریخ ${makeJalaliPicker('start', w.start, busy)}</label>
        <label class="field">تا تاریخ ${makeJalaliPicker('end', w.end, busy)}</label>
      </div>
      <button class="btn primary block" type="button" data-action="run-worker-report" ${busy ? 'disabled' : ''}>
        ${w.loading ? '<span class="spinner"></span>در حال بارگذاری…' : 'نمایش گزارش'}
      </button>
    </div>
    ${body}`, 'manager');
}

async function runWorkerReport() {
  const w = state.workerReport;
  if (!w || w.loading || state.busy) return;

  /* ---- Jalali → Gregorian conversion AT THE QUERY BOUNDARY ONLY ---- */
  let startTs, endTs;
  try {
    const sG = toGregorian(w.start.jy, w.start.jm, w.start.jd);
    const eG = toGregorian(w.end.jy, w.end.jm, w.end.jd);
    startTs = tehranDayStartMs(sG.gy, sG.gm, sG.gd);   // ← was: new Date(sG.gy, sG.gm-1, sG.gd, 0,0,0,0).getTime()
    endTs   = tehranDayEndMs  (eG.gy, eG.gm, eG.gd);   // ← was: new Date(eG.gy, eG.gm-1, eG.gd, 23,59,59,999).getTime()
  } catch {
    w.error = 'تاریخ نامعتبر است.';
    w.result = null; render(); return;
  }

  if (startTs > endTs) {
    w.error = 'تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.';
    w.result = null; render(); return;
  }

  w.loading = true; w.error = ''; w.result = null; render();

  try {
    /* Pull fresh current-month invoices so new submissions are included.
       Archives are already in memory from login. */
    if (state.invoiceService) await state.invoiceService.loadCurrent();

    const all = state.invoiceService ? state.invoiceService.allInvoices() : [];
    const byWorker = new Map();

    for (const inv of all) {
      if (inv.status !== STATUS.SUBMITTED) continue;                       // completed jobs only
      const ts = new Date(inv.submittedAt || inv.createdAt).getTime();
      if (!Number.isFinite(ts) || ts < startTs || ts > endTs) continue;    // inclusive range

      const key = inv.workerId || inv.workerName || '—';
      const row = byWorker.get(key) || { name: inv.workerName || 'کارگر حذف‌شده', jobs: 0, tips: 0, sum: 0 };
      const tip = Number(inv.tip || 0);
      const jobPrice = computeSubtotal(inv);                               // = "sum of job prices"
      row.jobs += 1;
      row.tips += tip;
      row.sum += jobPrice + tip;                                            // col4 = tips + job prices
      byWorker.set(key, row);
    }

    const rows = [...byWorker.values()].sort((a, b) => b.sum - a.sum);      // descending by sum
    const totals = rows.reduce((acc, r) => ({
      jobs: acc.jobs + r.jobs,
      tips: acc.tips + r.tips,
      sum:  acc.sum  + r.sum,
    }), { jobs: 0, tips: 0, sum: 0 });

    w.result = { rows, totals, startTs, endTs };
  } catch (err) {
    w.error = 'بارگذاری گزارش ناموفق بود: ' + (err?.message || 'خطای نامشخص');
    w.result = null;
  } finally {
    w.loading = false;
    render();
  }
}

/* ================= views: cashier ================= */
function viewCashierHome() {
  const drafts = state.invoiceService
    ? state.invoiceService.current.filter(i => i.status === STATUS.DRAFT).length
    : 0;
  const today = dailyReport(todayISO());
  return layout('منوی صندوق‌دار', `
    <div class="grid">
      <button class="tile" type="button" data-action="new-invoice">ثبت فاکتور جدید</button>
      <button class="tile" type="button" data-action="go" data-route="invoices">پیش‌فاکتورها${drafts ? ` (${fmt(drafts)})` : ''}</button>
      <button class="tile" type="button" data-action="go" data-route="daily">گزارش کار روز${today.count ? ` (${fmt(today.count)})` : ''}</button>
    </div>`);
}

function viewDaily() {
  const day = todayISO();
  const r = dailyReport(day);
  const rows = r.rows.length ? r.rows.map(w => `
    <li class="row">
      <span>${esc(w.name)}</span>
      <span class="grow"></span>
      <span class="muted">${fmt(w.count)} خودرو</span>
      <strong>${fmt(w.total)} تومان</strong>
    </li>`).join('') : '<li class="empty">کارگری ثبت نشده است.</li>';
  const busy = state.busy ? 'disabled' : '';

  return layout('گزارش کار روز', `
    <div class="toolbar">
      <span class="muted">تاریخ امروز: ${faDate(day)}</span>
      <span class="grow"></span>
      <button class="btn" type="button" data-action="refresh" ${busy}>به‌روزرسانی</button>
    </div>
    <div class="card">
      <div class="stats">
        <div class="stat"><span class="num">${fmt(r.count)}</span><span>تعداد خودرو</span></div>
        <div class="stat"><span class="num">${fmt(r.total)}</span><span>جمع مبالغ (تومان)</span></div>
        <div class="stat"><span class="num">${fmt(r.tips)}</span><span>جمع انعام (تومان)</span></div>
      </div>
    </div>
    <ul class="list">${rows}</ul>
    <p class="muted">فقط فاکتورهای نهایی‌شده‌ی امروز محاسبه می‌شوند؛ پیش‌فاکتورها و فاکتورهای حذف‌شده در این گزارش لحاظ نمی‌شوند.</p>`,
    homeRoute());
}

function viewCashier() {
  const d = state.draft || (state.draft = newDraft());
  const busy = state.busy;
  const types = state.data.carTypes || [];
  const type = types.find(t => t.id === d.carTypeId) || null;
  const cars = type ? (type.cars || []) : [];
  const workers = state.data.workers || [];
  const prices = (type && type.prices) || { wash: 0, vacuum: 0, wax: 0 };
  const editingFinal = d.status === STATUS.SUBMITTED;

  const typeOptions = types.map(t =>
    `<option value="${t.id}" ${t.id === d.carTypeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const carOptions = cars.map(c =>
    `<option value="${c.id}" ${c.id === d.carId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const workerOptions = workers.map(w =>
    `<option value="${w.id}" ${w.id === d.workerId ? 'selected' : ''}>${esc(w.name)}</option>`).join('');

  const extras = d.extras.map((x, i) => `
    <div class="extra-row">
      <input placeholder="شرح" data-extra="desc" data-i="${i}" value="${esc(x.desc)}" ${busy ? 'disabled' : ''}>
      <input type="number" min="0" step="1" placeholder="مبلغ" data-extra="amount" data-i="${i}" value="${x.amount || ''}" ${busy ? 'disabled' : ''}>
      <button type="button" class="btn danger" data-action="remove-extra" data-i="${i}" ${busy ? 'disabled' : ''}>×</button>
    </div>`).join('');

  const banner = editingFinal
    ? `<div class="banner">ویرایش فاکتور نهایی #${fmt(d.number)} — این عملیات فقط برای مدیر مجاز است و جمع فاکتور و گزارش‌ها پس از ذخیره به‌روزرسانی می‌شوند.</div>`
    : (d.id ? `<div class="banner">در حال ویرایش پیش فاکتور — تا زمان «ثبت نهایی»، در گزارش‌ها محاسبه نمی‌شود.</div>` : '');

  const buttons = editingFinal
    ? `<button class="btn primary block" type="submit" data-submit="edit" ${busy ? 'disabled' : ''}>
         ${busy ? '<span class="spinner"></span>در حال ذخیره…' : 'تأیید و ذخیره تغییرات'}
       </button>`
    : `<div class="grid2">
         <button class="btn" type="submit" data-submit="draft" ${busy ? 'disabled' : ''}>
           ${busy ? '<span class="spinner"></span>در حال ارسال…' : 'ذخیره پیش فاکتور'}
         </button>
         <button class="btn primary" type="submit" data-submit="final" ${busy ? 'disabled' : ''}>
           ${busy ? '<span class="spinner"></span>در حال ارسال…' : 'ثبت نهایی فاکتور'}
         </button>
       </div>`;

  return layout(editingFinal ? 'ویرایش فاکتور' : 'ثبت فاکتور', `
    ${banner}
    <form class="card" data-form="invoice">
      <label class="field">مشتری
        <input name="customer" data-draft="customer" value="${esc(d.customer)}" placeholder="نام مشتری" ${busy ? 'disabled' : ''}>
      </label>
      <label class="field">گروه خودرو
        <select data-draft="carTypeId" data-rerender ${busy ? 'disabled' : ''}>
          <option value="">— انتخاب کنید —</option>
          ${typeOptions}
        </select>
      </label>
      <label class="field">خودرو
        <select data-draft="carId" ${cars.length && !busy ? '' : 'disabled'}>
          <option value="">— انتخاب کنید —</option>
          ${carOptions}
        </select>
      </label>
      <label class="field">کارگر
        <select data-draft="workerId" ${busy ? 'disabled' : ''}>
          <option value="">— انتخاب کنید —</option>
          ${workerOptions}
        </select>
      </label>

      <fieldset>
        <legend>مبلغ</legend>
        <label class="check"><input type="checkbox" data-draft="services.wash" ${d.services.wash ? 'checked' : ''} ${busy ? 'disabled' : ''}> روشویی <span class="price">${fmt(prices.wash)}</span></label>
        <label class="check"><input type="checkbox" data-draft="services.vacuum" ${d.services.vacuum ? 'checked' : ''} ${busy ? 'disabled' : ''}> جارو <span class="price">${fmt(prices.vacuum)}</span></label>
        <label class="check"><input type="checkbox" data-draft="services.wax" ${d.services.wax ? 'checked' : ''} ${busy ? 'disabled' : ''}> واکس داشبورد <span class="price">${fmt(prices.wax)}</span></label>
      </fieldset>

      <fieldset>
        <legend>خدمات متفرقه</legend>
        ${extras}
        <button type="button" class="btn" data-action="add-extra" ${busy ? 'disabled' : ''}>افزودن ردیف</button>
      </fieldset>

      <div class="grid2">
        <label class="field">مبلغ انعام (تومان)
          <input type="number" min="0" step="1" data-draft="tip" value="${d.tip || ''}" ${busy ? 'disabled' : ''}>
        </label>
        <label class="field">تخفیف (تومان)
          <input type="number" min="0" step="1" data-draft="discount" value="${d.discount || ''}" ${busy ? 'disabled' : ''}>
        </label>
      </div>

      <div class="total">مبلغ کل: <strong id="invoice-total">${fmt(previewTotal(d))}</strong> تومان</div>
      ${buttons}
    </form>`, homeRoute());
}

/* ================= router ================= */
function viewForRoute() {
  const r = state.route;
  if (!isManager()) {
    if (r.name === 'invoices') return viewInvoices();
    if (r.name === 'daily') return viewDaily();
    if (r.name === 'cashier') return viewCashier();
    return viewCashierHome();
  }
  switch (r.name) {
    case 'cars': return viewCars();
    case 'cartype': return viewCarType(r.typeId);
    case 'tariffs': return viewTariffs();
    case 'tariff': return viewTariff(r.typeId);
    case 'workers': return viewWorkers();
    case 'reports': return viewReports();
    case 'invoices': return viewInvoices();
    case 'cashier': return viewCashier();
    case 'worker-report': return viewWorkerReport();
    default: return viewManagerHome();
  }
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = state.user ? viewForRoute() : viewLogin();

  const toast = document.getElementById('toast');
  if (state.toast) {
    toast.textContent = state.toast;
    toast.hidden = false;
    clearTimeout(render._t);
    render._t = setTimeout(() => { toast.hidden = true; state.toast = ''; }, 3200);
  } else {
    toast.hidden = true;
  }
}

function go(name, extra = {}) {
  state.route = { name, ...extra };
  state.error = '';
  render();
  if (name === 'worker-report' && state.workerReport
      && !state.workerReport.result && !state.workerReport.loading) {
    runWorkerReport();
  }
}

function setDraft(path, value) {
  if (!state.draft) return;
  const parts = path.split('.');
  let o = state.draft;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}

/* ================= actions ================= */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || state.busy) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'logout':
      state.user = state.store = state.data = state.draft = state.report = null;
      state.invoiceService = null;      // ← added
      state.workerReport = null;
      state.error = state.toast = ''; state.filter = 'all'; state.busy = false;
      state.route = { name: 'login' };
      render();
      break;

    case 'go': go(el.dataset.route); break;

    case 'new-invoice':
      state.draft = newDraft();
      go('cashier');
      break;

    case 'run-worker-report':
      await runWorkerReport();
      break;

    case 'open-invoice': {
      const found = state.invoiceService?.findInvoice(id);
      if (!found) { state.error = 'فاکتور یافت نشد.'; render(); break; }
      const inv = found.inv;
      if (inv.status === STATUS.VOID) { state.error = 'این فاکتور حذف شده و قابل ویرایش نیست.'; render(); break; }
      if (inv.status === STATUS.SUBMITTED && !isManager()) {
        state.error = 'فاکتور نهایی‌شده فقط برای مدیر قابل مشاهده و ویرایش است.';
        render(); break;
      }
      state.draft = draftFromInvoice(inv);
      go('cashier');
      break;
    }

    case 'delete-invoice': {
      const found = state.invoiceService?.findInvoice(id);
      if (!found) break;
      const label = found.inv.number ? `فاکتور #${fmt(found.inv.number)}` : 'این پیش فاکتور';
      if (!confirm(`آیا از حذف ${label} مطمئن هستید؟\nپس از حذف، از گزارش‌ها و آمار کارکرد کسر می‌شود.`)) break;
      const ok = await runInvoiceOp(
        () => state.invoiceService.deleteInvoice({ id }, actor()),
        'فاکتور با موفقیت حذف شد.'
      );
      if (ok) state.filter = 'all';
      render();
      break;
    }

    case 'filter':
      state.filter = el.dataset.value;
      render();
      break;

    case 'refresh': {
      state.busy = true; state.error = ''; render();
      try {
        const { data } = await state.store.read();
        if (data) state.data = data;
        await state.invoiceService.loadCurrent();
        if (isManager()) {
          await state.invoiceService.listArchives();
          await state.invoiceService.loadArchives();
        }
        state.toast = 'داده‌ها به‌روزرسانی شد.';
      } catch (err) {
        state.error = 'به‌روزرسانی ناموفق بود: ' + err.message;
      } finally {
        state.busy = false; render();
      }
      break;
    }

    case 'open-type': go('cartype', { typeId: id }); break;
    case 'open-tariff': go('tariff', { typeId: id }); break;

    case 'remove-type':
      if (confirm('این گروه و همه خودروهای آن حذف شود؟')) {
        await runOp(d => { d.carTypes = (d.carTypes || []).filter(t => t.id !== id); return d; }, 'حذف گروه خودرو');
      }
      render();
      break;

    case 'move-type': {
      const dir = Number(el.dataset.dir);
      await runOp(d => {
        const arr = d.carTypes || [];
        const i = arr.findIndex(t => t.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return d;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        return d;
      }, 'جابجایی گروه خودرو');
      render();
      break;
    }

    case 'remove-car': {
      const typeId = el.dataset.type;
      if (confirm('این خودرو حذف شود؟')) {
        await runOp(d => {
          const t = (d.carTypes || []).find(x => x.id === typeId);
          if (t) t.cars = (t.cars || []).filter(c => c.id !== id);
          return d;
        }, 'حذف خودرو');
      }
      render();
      break;
    }

    case 'move-car': {
      const typeId = el.dataset.type, dir = Number(el.dataset.dir);
      await runOp(d => {
        const t = (d.carTypes || []).find(x => x.id === typeId);
        if (!t) return d;
        const arr = t.cars || [];
        const i = arr.findIndex(c => c.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return d;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        return d;
      }, 'جابجایی خودرو');
      render();
      break;
    }

    case 'remove-worker':
      if (confirm('این کارگر حذف شود؟')) {
        await runOp(d => { d.workers = (d.workers || []).filter(w => w.id !== id); return d; }, 'حذف کارگر');
      }
      render();
      break;

    case 'add-extra':
      state.draft.extras.push({ desc: '', amount: 0 });
      render();
      break;

    case 'remove-extra':
      state.draft.extras.splice(Number(el.dataset.i), 1);
      render();
      break;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.draft) {
    setDraft(t.dataset.draft, t.type === 'checkbox' ? t.checked : t.value);
    refreshTotal();
  }
  if (t.dataset.extra && state.draft) {
    const i = Number(t.dataset.i), f = t.dataset.extra;
    if (!state.draft.extras[i]) return;
    state.draft.extras[i][f] = f === 'amount' ? Number(t.value || 0) : t.value;
    refreshTotal();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;

  if (t.dataset.jalali) {
    /* worker-report uses state.workerReport; reports view uses state.report */
    const target = state.route.name === 'worker-report' ? state.workerReport : state.report;
    if (!target) return;
    const which = t.dataset.jalali;
    const part  = t.dataset.part;
    if (!target[which] || typeof target[which] !== 'object' || !('jy' in target[which])) return;
    target[which][part] = Number(t.value);
    const max = jalaaliMonthLength(target[which].jy, target[which].jm);
    if (target[which].jd > max) target[which].jd = max;
    target.result = null;
    state.error = '';
    render();
    return;
  }
  
  if (!t.dataset.draft || !state.draft) return;
  setDraft(t.dataset.draft, t.type === 'checkbox' ? t.checked : t.value);
  if (t.dataset.rerender !== undefined) {
    if (t.dataset.draft === 'carTypeId') state.draft.carId = '';
    render();
  } else {
    refreshTotal();
  }
});

/* ================= forms ================= */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (state.busy) return;                             // feature 3

  const kind = form.dataset.form;
  const fd = new FormData(form);
  const id = form.dataset.id;

  try {
    /* ---- login ---- */
    if (kind === 'login') {
      state.busy = true; state.error = ''; render();
      try {
        await doLogin(fd.get('username'), fd.get('password'));
      } finally {
        state.busy = false; render();
      }
      return;
    }

    /* ---- cars / tariffs / workers (unchanged rules) ---- */
    if (kind === 'add-type') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new GateError('name', 'نام گروه را وارد کنید.');
      const res = await runOp(d => {
        d.carTypes = d.carTypes || [];
        d.carTypes.push({ id: uid('ct'), name, prices: { wash: 0, vacuum: 0, wax: 0 }, cars: [] });
        return d;
      }, 'افزودن گروه خودرو');
      if (res) render();
      return;
    }

    if (kind === 'add-car') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new GateError('name', 'نام خودرو را وارد کنید.');
      const res = await runOp(d => {
        const t = (d.carTypes || []).find(x => x.id === id);
        if (!t) throw new GateError('not_found', 'گروه یافت نشد.');
        t.cars = t.cars || [];
        t.cars.push({ id: uid('car'), name });
        return d;
      }, 'افزودن خودرو');
      if (res) render();
      return;
    }

    if (kind === 'tariff') {
      const wash = Number(fd.get('wash') || 0);
      const vacuum = Number(fd.get('vacuum') || 0);
      const wax = Number(fd.get('wax') || 0);
      const res = await runOp(d => {
        const t = (d.carTypes || []).find(x => x.id === id);
        if (!t) throw new GateError('not_found', 'گروه یافت نشد.');
        t.prices = { wash, vacuum, wax };
        return d;
      }, 'تنظیم تعرفه‌ها');
      if (res) render();
      return;
    }

    if (kind === 'add-worker') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new GateError('name', 'نام کارگر را وارد کنید.');
      const res = await runOp(d => {
        d.workers = d.workers || [];
        d.workers.push({ id: uid('w'), name });
        return d;
      }, 'افزودن کارگر');
      if (res) render();
      return;
    }

    if (kind === 'rename-worker') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new GateError('name', 'نام کارگر را وارد کنید.');
      const res = await runOp(d => {
        const w = (d.workers || []).find(x => x.id === id);
        if (w) w.name = name;
        return d;
      }, 'ویرایش نام کارگر');
      if (res) render();
      return;
    }

    if (kind === 'report') {
      const r = state.report;
      if (!r) return;
    
      /* Jalali → Gregorian conversion ONLY here, at the query boundary */
      let sG, eG;
      try {
        sG = toGregorian(r.start.jy, r.start.jm, r.start.jd);
        eG = toGregorian(r.end.jy,   r.end.jm,   r.end.jd);
      } catch {
        state.error = 'تاریخ نامعتبر است.'; render(); return;
      }
      const pad = n => String(n).padStart(2, '0');
      const start = `${sG.gy}-${pad(sG.gm)}-${pad(sG.gd)}`;
      const end   = `${eG.gy}-${pad(eG.gm)}-${pad(eG.gd)}`;
    
      if (start > end) {
        state.error = 'تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.';
        r.result = null;
        render(); return;
      }
    
      const workerIds = [...form.querySelectorAll('input[name="worker"]:checked')].map(i => i.value);
      r.workerIds = workerIds;
      r.result = computeReport({ start, end, workerIds });
      state.error = '';
      render();
      return;
    }

    /* ---- invoice: draft save / final submit / manager edit ---- */
    if (kind === 'invoice') {
      const d = state.draft;
      const editingFinal = d.status === STATUS.SUBMITTED;
      const mode = (e.submitter && e.submitter.dataset.submit)
        || (editingFinal ? 'edit' : 'draft');
    
      const payload = {
        id: d.id || null,
        idempotencyKey: d.idempotencyKey,
        customer: d.customer,
        carTypeId: d.carTypeId,
        carId: d.carId,
        workerId: d.workerId,
        services: { ...d.services },
        extras: d.extras.map(x => ({ desc: x.desc, amount: x.amount })),
        tip: d.tip,
        discount: d.discount,
      };
    
      if (mode === 'edit') {
        const before = state.invoiceService.findInvoice(d.id)?.inv;
        const beforeTotal = before ? Number(before.total || 0) : 0;
        const afterTotal = previewTotal(d);
        if (!confirm(
          `تأیید ویرایش فاکتور${d.number ? ' #' + fmt(d.number) : ''}\n` +
          `مبلغ قبلی: ${fmt(beforeTotal)} تومان\nمبلغ جدید: ${fmt(afterTotal)} تومان\n\n` +
          `با تأیید، تغییرات ذخیره و گزارش‌ها و جمع‌ها به‌روزرسانی می‌شوند. ادامه می‌دهید؟`
        )) return;
    
        const res = await runInvoiceOp(
          () => state.invoiceService.saveInvoice(payload, actor(), { submit: false }),
          'تغییرات فاکتور با موفقیت ذخیره شد.'
        );
        if (res) { state.draft = newDraft(); go('invoices'); }
        return;
      }
    
      const submit = mode === 'final';
      if (submit && !confirm('پس از ثبت نهایی، فاکتور قابل ویرایش توسط صندوق‌دار نخواهد بود. ادامه می‌دهید؟'))
        return;
    
      const res = await runInvoiceOp(
        () => state.invoiceService.saveInvoice(payload, actor(), { submit }),
        r => {
          const inv = r && r.invoice;
          if (!inv) return 'ذخیره شد.';
          if (submit && inv.number) return `فاکتور نهایی #${fmt(inv.number)} با موفقیت ثبت شد.`;
          return 'پیش فاکتور ذخیره شد.';
        }
      );
    
      if (res) {
        state.draft = newDraft();
        go(isManager() ? 'invoices' : 'cashierhome');
      }
      return;
    }
  } catch (err) {
    state.error = err && err.message ? err.message : String(err);
    render();
  }
});

/* ================= boot ================= */
render();
