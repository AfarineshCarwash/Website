import { sha256Hex, decryptToken } from './crypto.js';
import { GitHubStore } from './github.js';

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('fa-IR');
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isoDate = iso => {
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const faDate = iso => new Date(iso).toLocaleDateString('fa-IR');
const faTime = iso => new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const SERVICE_NAMES = { wash: 'روشویی', vacuum: 'جارو', wax: 'واکس داشبورد' };

const state = {
  data: null, user: null, store: null,
  route: { name: 'login' },
  draft: null, report: null, error: '', toast: '',
};

function newDraft() {
  return {
    customer: '', carTypeId: '', carId: '', workerId: '',
    services: { wash: true, vacuum: false, wax: false },
    extras: [], tip: 0, discount: 0,
  };
}

async function loadJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`خواندن ${path} ناموفق بود (${res.status})`);
  return res.json();
}

/* ---------------- login ---------------- */
async function doLogin(username, password) {
  const data = await loadJson('data.json');
  const user = (data.users || []).find(
    u => String(u.username).toLowerCase() === String(username).trim().toLowerCase()
  );
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
  state.route = { name: user.role === 'manager' ? 'manager' : 'cashier' };
  state.error = '';
}

/* ---------------- saving ---------------- */
async function save(mutator, message) {
  state.error = '';
  try {
    state.data = await state.store.update(mutator, message);
    state.toast = message;
  } catch (e) {
    state.error = 'ذخیره‌سازی ناموفق بود: ' + e.message;
  }
  render();
}

/* ---------------- totals ---------------- */
function computeTotal(d) {
  const type = (state.data.carTypes || []).find(t => t.id === d.carTypeId);
  const p = (type && type.prices) || {};
  let sum = 0;
  if (d.services.wash) sum += Number(p.wash || 0);
  if (d.services.vacuum) sum += Number(p.vacuum || 0);
  if (d.services.wax) sum += Number(p.wax || 0);
  for (const x of d.extras) sum += Number(x.amount || 0);
  sum += Number(d.tip || 0);
  sum -= Number(d.discount || 0);
  return Math.max(0, sum);
}

function refreshTotal() {
  const el = document.getElementById('invoice-total');
  if (el && state.draft) el.textContent = fmt(computeTotal(state.draft));
}

/* ---------------- report ---------------- */
function computeReport({ start, end, workerIds }) {
  const set = new Set(workerIds);
  const invoices = (state.data.invoices || []).filter(inv => {
    const d = isoDate(inv.createdAt);
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

/* ---------------- views ---------------- */
function layout(title, body, back) {
  return `
  <header class="topbar">
    <span class="brand">کارواش آفرینش</span>
    <span class="spacer"></span>
    <span class="who">${esc(state.user.username)}</span>
    <button class="btn ghost" type="button" data-action="logout">خروج</button>
  </header>
  <div class="content">
    <div class="pagehead">
      <h2>${esc(title)}</h2>
      ${back ? `<button class="btn ghost" type="button" data-action="go" data-route="${back}">بازگشت</button>` : ''}
    </div>
    ${state.error ? `<div class="alert error">${esc(state.error)}</div>` : ''}
    ${body}
  </div>`;
}

function viewLogin() {
  return `
  <div class="login-wrap">
    <form class="card login" data-form="login">
      <h1>کارواش آفرینش</h1>
      <p class="muted">به کارواش آفرینش خوش آمدید.</p>
      <label class="field">نام کاربری
        <input name="username" required autocomplete="username" dir="ltr">
      </label>
      <label class="field">رمز ورود
        <input name="password" type="password" required autocomplete="current-password" dir="ltr">
      </label>
      ${state.error ? `<p class="alert error">${esc(state.error)}</p>` : ''}
      <button class="btn primary block" type="submit">ورود</button>
    </form>
  </div>`;
}

function viewManagerHome() {
  return layout('منوی مدیر', `
    <div class="grid">
      <button class="tile" type="button" data-action="go" data-route="cars">مدیریت خودروها</button>
      <button class="tile" type="button" data-action="go" data-route="tariffs">تنظیم تعرفه‌ها</button>
      <button class="tile" type="button" data-action="go" data-route="workers">فهرست کارگران</button>
      <button class="tile" type="button" data-action="go" data-route="reports">گزارش کارکرد</button>
      <button class="tile" type="button" data-action="go" data-route="cashier">ثبت فاکتور</button>
    </div>`);
}

function viewCars() {
  const types = state.data.carTypes || [];
  const list = types.length ? types.map((t, i) => `
    <li class="row">
      <button class="link" type="button" data-action="open-type" data-id="${t.id}">${esc(t.name)}</button>
      <span class="muted">${fmt((t.cars || []).length)} خودرو</span>
      <span class="grow"></span>
      <button class="btn icon" type="button" data-action="move-type" data-id="${t.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn icon" type="button" data-action="move-type" data-id="${t.id}" data-dir="1" ${i === types.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="btn danger" type="button" data-action="remove-type" data-id="${t.id}">حذف</button>
    </li>`).join('') : '<li class="empty">گروهی ثبت نشده است.</li>';

  return layout('مدیریت خودروها', `
    <ul class="list">${list}</ul>
    <form class="card" data-form="add-type">
      <h3>افزودن گروه</h3>
      <div class="inline">
        <input name="name" placeholder="نام گروه خودرو" required>
        <button class="btn primary" type="submit">افزودن</button>
      </div>
    </form>`, 'manager');
}

function viewCarType(typeId) {
  const type = (state.data.carTypes || []).find(t => t.id === typeId);
  if (!type) return layout('گروه خودرو', '<p class="muted">گروه یافت نشد.</p>', 'cars');

  const cars = type.cars || [];
  const list = cars.length ? cars.map((c, i) => `
    <li class="row">
      <span>${esc(c.name)}</span>
      <span class="grow"></span>
      <button class="btn icon" type="button" data-action="move-car" data-type="${type.id}" data-id="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn icon" type="button" data-action="move-car" data-type="${type.id}" data-id="${c.id}" data-dir="1" ${i === cars.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="btn danger" type="button" data-action="remove-car" data-type="${type.id}" data-id="${c.id}">حذف</button>
    </li>`).join('') : '<li class="empty">خودرویی ثبت نشده است.</li>';

  return layout(`خودروهای ${type.name}`, `
    <ul class="list">${list}</ul>
    <form class="card" data-form="add-car" data-id="${type.id}">
      <h3>افزودن خودرو</h3>
      <div class="inline">
        <input name="name" placeholder="نام خودرو" required>
        <button class="btn primary" type="submit">افزودن</button>
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

  return layout(`تعرفه‌های ${type.name}`, `
    <form class="card" data-form="tariff" data-id="${type.id}">
      <label class="field">روشویی (تومان)<input type="number" min="0" step="1" name="wash" value="${Number(p.wash || 0)}"></label>
      <label class="field">جارو (تومان)<input type="number" min="0" step="1" name="vacuum" value="${Number(p.vacuum || 0)}"></label>
      <label class="field">واکس داشبورد (تومان)<input type="number" min="0" step="1" name="wax" value="${Number(p.wax || 0)}"></label>
      <button class="btn primary block" type="submit">ذخیره تعرفه‌ها</button>
    </form>`, 'tariffs');
}

function viewWorkers() {
  const workers = state.data.workers || [];
  const list = workers.length ? workers.map(w => `
    <li class="row">
      <form class="inline grow" data-form="rename-worker" data-id="${w.id}">
        <input name="name" value="${esc(w.name)}" required>
        <button class="btn" type="submit">ذخیره نام</button>
      </form>
      <button class="btn danger" type="button" data-action="remove-worker" data-id="${w.id}">حذف</button>
    </li>`).join('') : '<li class="empty">کارگری ثبت نشده است.</li>';

  return layout('فهرست کارگران', `
    <ul class="list">${list}</ul>
    <form class="card" data-form="add-worker">
      <h3>افزودن کارگر</h3>
      <div class="inline">
        <input name="name" placeholder="نام کارگر" required>
        <button class="btn primary" type="submit">افزودن</button>
      </div>
    </form>`, 'manager');
}

function viewReports() {
  const workers = state.data.workers || [];
  const r = state.report || { start: '', end: '', workerIds: workers.map(w => w.id), result: null };
  const selected = new Set(r.workerIds);

  const checks = workers.map(w => `
    <label class="check">
      <input type="checkbox" name="worker" value="${w.id}" ${selected.has(w.id) ? 'checked' : ''}>
      ${esc(w.name)}
    </label>`).join('') || '<p class="muted">کارگری ثبت نشده است.</p>';

  let resultHtml = '';
  if (r.result) {
    const rows = r.result.invoices.length ? r.result.invoices.map(inv => `
      <tr>
        <td>${faDate(inv.createdAt)}</td>
        <td>${faTime(inv.createdAt)}</td>
        <td>${esc(inv.customer || '—')}</td>
        <td>${esc(inv.carTypeName)} / ${esc(inv.carName)}</td>
        <td>${esc(inv.workerName)}</td>
        <td>${esc(servicesLabel(inv))}</td>
        <td>${fmt(inv.tip)}</td>
        <td>${fmt(inv.discount)}</td>
        <td><strong>${fmt(inv.total)}</strong></td>
      </tr>`).join('')
      : '<tr><td colspan="9" class="empty">فاکتوری در این بازه یافت نشد.</td></tr>';

    resultHtml = `
      <div class="card">
        <div class="stats">
          <div class="stat"><span class="num">${fmt(r.result.count)}</span><span>تعداد خودرو شسته‌شده</span></div>
          <div class="stat"><span class="num">${fmt(r.result.total)}</span><span>جمع کل (تومان)</span></div>
          <div class="stat"><span class="num">${fmt(r.result.tips)}</span><span>جمع انعام (تومان)</span></div>
        </div>
      </div>
      <div class="card">
        <h3>فهرست فاکتورها</h3>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>تاریخ</th><th>ساعت</th><th>مشتری</th><th>خودرو</th><th>کارگر</th>
              <th>خدمات</th><th>انعام</th><th>تخفیف</th><th>مبلغ کل</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  return layout('گزارش کارکرد', `
    <form class="card" data-form="report">
      <div class="grid2">
        <label class="field">از تاریخ<input type="date" name="start" value="${esc(r.start)}"></label>
        <label class="field">تا تاریخ<input type="date" name="end" value="${esc(r.end)}"></label>
      </div>
      <fieldset>
        <legend>کارگران (خالی = همه)</legend>
        ${checks}
      </fieldset>
      <button class="btn primary block" type="submit">نمایش گزارش</button>
    </form>
    ${resultHtml}`, 'manager');
}

function viewCashier() {
  const d = state.draft;
  const types = state.data.carTypes || [];
  const type = types.find(t => t.id === d.carTypeId) || null;
  const cars = type ? (type.cars || []) : [];
  const workers = state.data.workers || [];
  const prices = (type && type.prices) || { wash: 0, vacuum: 0, wax: 0 };

  const typeOptions = types.map(t =>
    `<option value="${t.id}" ${t.id === d.carTypeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const carOptions = cars.map(c =>
    `<option value="${c.id}" ${c.id === d.carId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const workerOptions = workers.map(w =>
    `<option value="${w.id}" ${w.id === d.workerId ? 'selected' : ''}>${esc(w.name)}</option>`).join('');

  const extras = d.extras.map((x, i) => `
    <div class="extra-row">
      <input placeholder="شرح" data-extra="desc" data-i="${i}" value="${esc(x.desc)}">
      <input type="number" min="0" step="1" placeholder="مبلغ" data-extra="amount" data-i="${i}" value="${x.amount || ''}">
      <button type="button" class="btn danger" data-action="remove-extra" data-i="${i}">×</button>
    </div>`).join('');

  const back = state.user.role === 'manager' ? 'manager' : null;

  return layout('ثبت فاکتور', `
    <form class="card" data-form="invoice">
      <label class="field">مشتری
        <input name="customer" data-draft="customer" value="${esc(d.customer)}" placeholder="نام مشتری">
      </label>
      <label class="field">گروه خودرو
        <select data-draft="carTypeId" data-rerender>
          <option value="">— انتخاب کنید —</option>
          ${typeOptions}
        </select>
      </label>
      <label class="field">خودرو
        <select data-draft="carId" ${cars.length ? '' : 'disabled'}>
          <option value="">— انتخاب کنید —</option>
          ${carOptions}
        </select>
      </label>
      <label class="field">کارگر
        <select data-draft="workerId">
          <option value="">— انتخاب کنید —</option>
          ${workerOptions}
        </select>
      </label>

      <fieldset>
        <legend>مبلغ</legend>
        <label class="check"><input type="checkbox" data-draft="services.wash" ${d.services.wash ? 'checked' : ''}> روشویی <span class="price">${fmt(prices.wash)}</span></label>
        <label class="check"><input type="checkbox" data-draft="services.vacuum" ${d.services.vacuum ? 'checked' : ''}> جارو <span class="price">${fmt(prices.vacuum)}</span></label>
        <label class="check"><input type="checkbox" data-draft="services.wax" ${d.services.wax ? 'checked' : ''}> واکس داشبورد <span class="price">${fmt(prices.wax)}</span></label>
      </fieldset>

      <fieldset>
        <legend>خدمات متفرقه</legend>
        ${extras}
        <button type="button" class="btn" data-action="add-extra">افزودن ردیف</button>
      </fieldset>

      <div class="grid2">
        <label class="field">مبلغ انعام (تومان)
          <input type="number" min="0" step="1" data-draft="tip" value="${d.tip || ''}">
        </label>
        <label class="field">تخفیف (تومان)
          <input type="number" min="0" step="1" data-draft="discount" value="${d.discount || ''}">
        </label>
      </div>

      <div class="total">مبلغ کل: <strong id="invoice-total">${fmt(computeTotal(d))}</strong> تومان</div>
      <button class="btn primary block" type="submit">ثبت فاکتور</button>
    </form>`, back);
}

/* ---------------- render ---------------- */
function viewForRoute() {
  const r = state.route;
  if (r.name === 'cashier') return viewCashier();
  if (state.user.role !== 'manager') return viewCashier();

  switch (r.name) {
    case 'cars': return viewCars();
    case 'cartype': return viewCarType(r.typeId);
    case 'tariffs': return viewTariffs();
    case 'tariff': return viewTariff(r.typeId);
    case 'workers': return viewWorkers();
    case 'reports': return viewReports();
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
    render._t = setTimeout(() => { toast.hidden = true; state.toast = ''; }, 3000);
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

/* ---------------- actions ---------------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'logout':
      state.user = null; state.store = null; state.data = null;
      state.draft = null; state.report = null; state.error = ''; state.toast = '';
      state.route = { name: 'login' };
      render();
      break;

    case 'go':
      go(el.dataset.route);
      break;

    case 'open-type':
      go('cartype', { typeId: id });
      break;

    case 'open-tariff':
      go('tariff', { typeId: id });
      break;

    case 'remove-type':
      if (confirm('این گروه و همه خودروهای آن حذف شود؟')) {
        await save(d => { d.carTypes = (d.carTypes || []).filter(t => t.id !== id); return d; }, 'حذف گروه خودرو');
      }
      break;

    case 'move-type': {
      const dir = Number(el.dataset.dir);
      await save(d => {
        const arr = d.carTypes || [];
        const i = arr.findIndex(t => t.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return d;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        return d;
      }, 'جابجایی گروه خودرو');
      break;
    }

    case 'remove-car': {
      const typeId = el.dataset.type;
      if (confirm('این خودرو حذف شود؟')) {
        await save(d => {
          const t = (d.carTypes || []).find(x => x.id === typeId);
          if (t) t.cars = (t.cars || []).filter(c => c.id !== id);
          return d;
        }, 'حذف خودرو');
      }
      break;
    }

    case 'move-car': {
      const typeId = el.dataset.type, dir = Number(el.dataset.dir);
      await save(d => {
        const t = (d.carTypes || []).find(x => x.id === typeId);
        if (!t) return d;
        const arr = t.cars || [];
        const i = arr.findIndex(c => c.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return d;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        return d;
      }, 'جابجایی خودرو');
      break;
    }

    case 'remove-worker':
      if (confirm('این کارگر حذف شود؟')) {
        await save(d => { d.workers = (d.workers || []).filter(w => w.id !== id); return d; }, 'حذف کارگر');
      }
      break;

    case 'add-extra':
      state.draft.extras.push({ desc: '', amount: 0 });
      render();
      break;

    case 'remove-extra': {
      state.draft.extras.splice(Number(el.dataset.i), 1);
      render();
      break;
    }
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

/* ---------------- forms ---------------- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();

  const kind = form.dataset.form;
  const fd = new FormData(form);
  const id = form.dataset.id;

  try {
    if (kind === 'login') {
      state.error = '';
      await doLogin(fd.get('username'), fd.get('password'));
      render();
      return;
    }

    if (kind === 'add-type') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new Error('نام گروه را وارد کنید.');
      await save(d => {
        d.carTypes = d.carTypes || [];
        d.carTypes.push({ id: uid('ct'), name, prices: { wash: 0, vacuum: 0, wax: 0 }, cars: [] });
        return d;
      }, 'افزودن گروه خودرو');
      return;
    }

    if (kind === 'add-car') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new Error('نام خودرو را وارد کنید.');
      await save(d => {
        const t = (d.carTypes || []).find(x => x.id === id);
        if (!t) throw new Error('گروه یافت نشد.');
        t.cars = t.cars || [];
        t.cars.push({ id: uid('car'), name });
        return d;
      }, 'افزودن خودرو');
      return;
    }

    if (kind === 'tariff') {
      const wash = Number(fd.get('wash') || 0);
      const vacuum = Number(fd.get('vacuum') || 0);
      const wax = Number(fd.get('wax') || 0);
      await save(d => {
        const t = (d.carTypes || []).find(x => x.id === id);
        if (!t) throw new Error('گروه یافت نشد.');
        t.prices = { wash, vacuum, wax };
        return d;
      }, 'تنظیم تعرفه‌ها');
      return;
    }

    if (kind === 'add-worker') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new Error('نام کارگر را وارد کنید.');
      await save(d => {
        d.workers = d.workers || [];
        d.workers.push({ id: uid('w'), name });
        return d;
      }, 'افزودن کارگر');
      return;
    }

    if (kind === 'rename-worker') {
      const name = String(fd.get('name') || '').trim();
      if (!name) throw new Error('نام کارگر را وارد کنید.');
      await save(d => {
        const w = (d.workers || []).find(x => x.id === id);
        if (w) w.name = name;
        return d;
      }, 'ویرایش نام کارگر');
      return;
    }

    if (kind === 'report') {
      const start = String(fd.get('start') || '');
      const end = String(fd.get('end') || '');
      const workerIds = [...form.querySelectorAll('input[name="worker"]:checked')].map(i => i.value);
      const result = computeReport({ start, end, workerIds });
      state.report = { start, end, workerIds, result };
      render();
      return;
    }

    if (kind === 'invoice') {
      const d = state.draft;
      const type = (state.data.carTypes || []).find(t => t.id === d.carTypeId);
      if (!type) throw new Error('گروه خودرو را انتخاب کنید.');
      const car = (type.cars || []).find(c => c.id === d.carId);
      if (!car) throw new Error('خودرو را انتخاب کنید.');
      const worker = (state.data.workers || []).find(w => w.id === d.workerId);
      if (!worker) throw new Error('کارگر را انتخاب کنید.');

      const p = type.prices || {};
      const extras = d.extras
        .filter(x => String(x.desc || '').trim() || Number(x.amount))
        .map(x => ({ desc: String(x.desc || '').trim(), amount: Number(x.amount || 0) }));

      const invoice = {
        id: uid('inv'),
        createdAt: new Date().toISOString(),
        customer: String(d.customer || '').trim(),
        carTypeId: type.id, carTypeName: type.name,
        carId: car.id, carName: car.name,
        workerId: worker.id, workerName: worker.name,
        services: { ...d.services },
        prices: { wash: Number(p.wash || 0), vacuum: Number(p.vacuum || 0), wax: Number(p.wax || 0) },
        extras,
        tip: Number(d.tip || 0),
        discount: Number(d.discount || 0),
        total: computeTotal(d),
        createdBy: state.user.username,
      };

      await save(data => {
        data.invoices = data.invoices || [];
        data.invoices.push(invoice);
        return data;
      }, 'ثبت فاکتور');

      state.draft = newDraft();
      render();
      return;
    }
  } catch (err) {
    state.error = err.message || String(err);
    render();
  }
});

/* ---------------- boot ---------------- */
render();
