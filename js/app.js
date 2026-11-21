import { sha256Hex, decryptToken } from './crypto.js';
import { GitHubStore } from './github.js';
import {
  GateError, upsertInvoice, deleteInvoice, computeTotal,
  SERVICE_NAMES, STATUS, ROLES,
} from './gate.js';

/* ================= helpers ================= */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('fa-IR');
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : uid('key'));
const isoDate = v => {
  const d = new Date(v), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const todayISO = () => isoDate(new Date().toISOString());
const faDate = v => new Date(v).toLocaleDateString('fa-IR');
const faTime = v => new Date(v).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

const state = {
  data: null, user: null, store: null,
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
  state.draft = newDraft();
  state.route = { name: user.role === ROLES.MANAGER ? 'manager' : 'cashierhome' };
  state.error = '';
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
function dailyReport(day) {
  const rows = new Map((state.data.workers || []).map(w => [w.id, { id: w.id, name: w.name, count: 0, total: 0, tips: 0 }]));
  let count = 0, total = 0, tips = 0;
  for (const inv of state.data.invoices || []) {
    if (inv.status !== STATUS.SUBMITTED) continue;                       // drafts & void excluded
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
  const set = new Set(workerIds);
  const invoices = (state.data.invoices || []).filter(inv => {
    if (inv.status !== STATUS.SUBMITTED) return false;                   // drafts & void excluded
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
  const r = state.report || { start: '', end: '', workerIds: workers.map(w => w.id), result: null };
  const selected = new Set(r.workerIds);
  const busy = state.busy ? 'disabled' : '';

  const checks = workers.map(w => `
    <label class="check">
      <input type="checkbox" name="worker" value="${w.id}" ${selected.has(w.id) ? 'checked' : ''} ${busy}>
      ${esc(w.name)}
    </label>`).join('') || '<p class="muted">کارگری ثبت نشده است.</p>';

  let resultHtml = '';
  if (r.result) {
    const rows = r.result.invoices.length ? r.result.invoices.map(inv => `
      <tr>
        <td>${inv.number ? '#' + fmt(inv.number) : '—'}</td>
        <td>${faDate(inv.submittedAt || inv.createdAt)}</td>
        <td>${faTime(inv.submittedAt || inv.createdAt)}</td>
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
        <label class="field">از تاریخ<input type="date" name="start" value="${esc(r.start)}" ${busy}></label>
        <label class="field">تا تاریخ<input type="date" name="end" value="${esc(r.end)}" ${busy}></label>
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
        <span>${faDate(inv.createdAt)} ${faTime(inv.createdAt)}</span>
        <span>${esc(servicesLabel(inv))}</span>
        ${inv.status === STATUS.VOID ? `<span>حذف: ${faDate(inv.deletedAt)} توسط ${esc(inv.deletedBy || '—')}</span>` : ''}
      </div>
    </div>
    <div class="inv-actions">${actions.join('')}</div>
  </li>`;
}

function viewInvoices() {
  const manager = isManager();
  // صندوق‌دار فقط پیش‌فاکتورها را می‌بیند؛ فاکتورهای نهایی و حذف‌شده از دید او پنهان‌اند.
  const filter = manager ? (state.filter || 'all') : STATUS.DRAFT;

  const all = (state.data.invoices || [])
    .filter(inv => manager || inv.status === STATUS.DRAFT)   // ← the gate: cashiers never see submitted/void
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const filters = manager
    ? [['all', 'همه'], ['draft', 'پیش‌فاکتور'], ['submitted', 'نهایی'], ['void', 'حذف‌شده']]
    : [['draft', 'پیش‌فاکتور']];

  const list = all.filter(inv => filter === 'all' ? inv.status !== STATUS.VOID : inv.status === filter);
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

/* ================= views: cashier ================= */
function viewCashierHome() {
  const drafts = (state.data.invoices || []).filter(i => i.status === STATUS.DRAFT).length;
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
    </form>`, 'invoices');
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
      state.error = state.toast = ''; state.filter = 'all'; state.busy = false;
      state.route = { name: 'login' };
      render();
      break;

    case 'go': go(el.dataset.route); break;

    case 'new-invoice':
      state.draft = newDraft();
      go('cashier');
      break;

    case 'open-invoice': {
      const inv = (state.data.invoices || []).find(i => i.id === id);
      if (!inv) { state.error = 'فاکتور یافت نشد.'; render(); break; }
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
      const inv = (state.data.invoices || []).find(i => i.id === id);
      if (!inv) break;
      const label = inv.number ? `فاکتور #${fmt(inv.number)}` : 'این پیش فاکتور';
      if (!confirm(`آیا از حذف ${label} مطمئن هستید؟\nپس از حذف، از گزارش‌ها و آمار کارکرد کسر می‌شود.`)) break;
      const ok = await runOp(
        d => deleteInvoice(d, { id }, actor()),
        `حذف فاکتور ${inv.number ? '#' + inv.number : ''}`.trim(),
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
      const start = String(fd.get('start') || '');
      const end = String(fd.get('end') || '');
      const workerIds = [...form.querySelectorAll('input[name="worker"]:checked')].map(i => i.value);
      state.report = { start, end, workerIds, result: computeReport({ start, end, workerIds }) };
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
        const before = (state.data.invoices || []).find(i => i.id === d.id);
        const beforeTotal = before ? Number(before.total || 0) : 0;
        const afterTotal = previewTotal(d);
        if (!confirm(
          `تأیید ویرایش فاکتور${d.number ? ' #' + fmt(d.number) : ''}\n` +
          `مبلغ قبلی: ${fmt(beforeTotal)} تومان\n` +
          `مبلغ جدید: ${fmt(afterTotal)} تومان\n\n` +
          `با تأیید، تغییرات ذخیره و گزارش‌ها و جمع‌ها به‌روزرسانی می‌شوند. ادامه می‌دهید؟`
        )) return;

        const res = await runOp(
          data => upsertInvoice(data, payload, actor(), { submit: false }),
          `ویرایش فاکتور${d.number ? ' #' + d.number : ''}`,
          'تغییرات فاکتور با موفقیت ذخیره شد.'
        );
        if (res) { state.draft = newDraft(); go('invoices'); }
        return;
      }

      const submit = mode === 'final';

      if (submit && !confirm('پس از ثبت نهایی، فاکتور قابل ویرایش توسط صندوق‌دار نخواهد بود. ادامه می‌دهید؟'))
        return;

      const res = await runOp(
        data => upsertInvoice(data, payload, actor(), { submit }),
        submit ? 'ثبت نهایی فاکتور' : 'ذخیره پیش فاکتور',
        r => {
          const inv = r && r.invoice;
          if (!inv) return 'ذخیره شد.';
          if (submit && inv.number) return `فاکتور نهایی #${fmt(inv.number)} با موفقیت ثبت شد.`;
          return 'پیش فاکتور ذخیره شد.';
        }
      );

      if (res) {
        state.draft = newDraft();
        go(isManager() ? 'invoices' : 'cashierhome');   // ← cashier goes home; manager stays on the list
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
