/* js/gate.js — قواعد کسب‌وکار و اعتبارسنجی مشترک (مرورگر + GitHub Actions) */

export const SERVICE_NAMES = { wash: 'روشویی', vacuum: 'جارو', wax: 'واکس داشبورد' };
export const ROLES = { MANAGER: 'manager', CASHIER: 'cashier' };
export const STATUS = { DRAFT: 'draft', SUBMITTED: 'submitted', VOID: 'void' };

export class GateError extends Error {
  constructor(code, message) { super(message); this.name = 'GateError'; this.code = code; }
}

/* ---------- permissions matrix (the single source of truth) ---------- */
const PERMS = {
  'invoice.save':   [ROLES.CASHIER, ROLES.MANAGER],
  'invoice.submit': [ROLES.CASHIER, ROLES.MANAGER],
  'invoice.edit':   [ROLES.MANAGER],
  'invoice.delete': [ROLES.MANAGER],
};

export function can(role, action) {
  const list = PERMS[action];
  return Array.isArray(list) && list.includes(role);
}

export function assertCan(actor, action, message) {
  if (!actor || !actor.username) throw new GateError('actor', 'کاربر شناسایی نشد.');
  if (!can(actor.role, action))
    throw new GateError('forbidden', message || 'شما اجازه انجام این عملیات را ندارید.');
}

/* ---------- numbers / totals ---------- */
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function requireInt(v, label, { min = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min)
    throw new GateError('invalid_number', `${label} باید یک عدد صحیح بزرگ‌تر یا مساوی ${min} باشد.`);
  return n;
}

export function computeSubtotal(inv = {}) {
  const p = inv.prices || {}, s = inv.services || {};
  let sum = 0;
  if (s.wash) sum += num(p.wash);
  if (s.vacuum) sum += num(p.vacuum);
  if (s.wax) sum += num(p.wax);
  for (const x of inv.extras || []) sum += num(x && x.amount);
  return sum;
}

export function computeTotal(inv = {}) {
  return Math.max(0, computeSubtotal(inv) + num(inv.tip) - num(inv.discount));
}

/* ---------- input normalisation + validation ---------- */
export function normalizeInvoiceInput(payload = {}, data = {}, opts = {}) {
  const strict = !!opts.strict;

  const types = data.carTypes || [];
  const type = types.find(t => t.id === payload.carTypeId) || null;
  if (payload.carTypeId && !type) throw new GateError('car_type', 'گروه خودروی انتخاب‌شده معتبر نیست.');
  if (strict && !type) throw new GateError('car_type', 'گروه خودرو را انتخاب کنید.');

  const car = type ? (type.cars || []).find(c => c.id === payload.carId) || null : null;
  if (payload.carId && !car) throw new GateError('car', 'خودروی انتخاب‌شده معتبر نیست.');
  if (strict && type && !car) throw new GateError('car', 'خودرو را انتخاب کنید.');

  const worker = (data.workers || []).find(w => w.id === payload.workerId) || null;
  if (payload.workerId && !worker) throw new GateError('worker', 'کارگر انتخاب‌شده معتبر نیست.');
  if (strict && !worker) throw new GateError('worker', 'کارگر را انتخاب کنید.');

  const services = {
    wash: !!(payload.services && payload.services.wash),
    vacuum: !!(payload.services && payload.services.vacuum),
    wax: !!(payload.services && payload.services.wax),
  };
  const prices = {
    wash: num(type && type.prices && type.prices.wash),
    vacuum: num(type && type.prices && type.prices.vacuum),
    wax: num(type && type.prices && type.prices.wax),
  };

  const rawExtras = Array.isArray(payload.extras) ? payload.extras : [];
  if (rawExtras.length > 20) throw new GateError('extras', 'تعداد خدمات متفرقه بیش از حد مجاز است (۲۰).');
  const extras = rawExtras
    .map(x => ({
      desc: String((x && x.desc) ?? '').trim().slice(0, 120),
      amount: (x && x.amount !== '' && x.amount != null) ? requireInt(x.amount, 'مبلغ خدمات متفرقه') : 0,
    }))
    .filter(x => x.desc || x.amount);
  if (extras.some(x => !x.desc)) throw new GateError('extras', 'شرح خدمات متفرقه را وارد کنید.');

  const tip = (payload.tip === '' || payload.tip == null) ? 0 : requireInt(payload.tip, 'مبلغ انعام');
  const discount = (payload.discount === '' || payload.discount == null) ? 0 : requireInt(payload.discount, 'مبلغ تخفیف');

  const subtotal = computeSubtotal({ services, prices, extras });
  if (discount > subtotal + tip)
    throw new GateError('discount', 'مبلغ تخفیف نمی‌تواند بیشتر از جمع فاکتور باشد.');

  if (strict && !services.wash && !services.vacuum && !services.wax && !extras.length)
    throw new GateError('services', 'حداقل یک خدمت را انتخاب کنید.');

  return {
    customer: String(payload.customer ?? '').trim().slice(0, 120),
    carTypeId: type ? type.id : '',
    carTypeName: type ? type.name : '',
    carId: car ? car.id : '',
    carName: car ? car.name : '',
    workerId: worker ? worker.id : '',
    workerName: worker ? worker.name : '',
    services, prices, extras, tip, discount,
    subtotal,
    total: subtotal + tip - discount,
  };
}

/* ---------- operations ---------- */
export function upsertInvoice(data, payload = {}, actor, opts = {}) {
  const submit = !!opts.submit;
  const invs = Array.isArray(data.invoices) ? data.invoices : (data.invoices = []);
  const now = new Date().toISOString();
  const key = payload.idempotencyKey ? String(payload.idempotencyKey) : null;

  /* 1) idempotency — a repeated request must never create a second invoice */
  let inv = payload.id ? invs.find(i => i.id === payload.id) : null;
  if (!inv && key) {
    const dup = invs.find(i => i.idempotencyKey === key);
    if (dup) {
      if (dup.status === STATUS.DRAFT && submit) inv = dup;      // finish the interrupted submit
      else return { data, invoice: dup, deduped: true };          // already done
    }
  }
  if (payload.id && !inv) throw new GateError('not_found', 'فاکتور یافت نشد.');

  /* 2) permissions — enforced here, never only in the UI */
  const isNew = !inv;
  if (isNew) {
    assertCan(actor, submit ? 'invoice.submit' : 'invoice.save');
  } else if (inv.status === STATUS.VOID) {
    throw new GateError('void', 'این فاکتور حذف شده و قابل ویرایش نیست.');
  } else if (inv.status === STATUS.SUBMITTED) {
    if (!can(actor && actor.role, 'invoice.edit'))
      throw new GateError('forbidden', 'فاکتور نهایی‌شده قابل ویرایش نیست؛ فقط مدیر می‌تواند آن را تغییر دهد.');
  } else {
    assertCan(actor, 'invoice.save');
  }

  /* 3) validation + server-side recomputation of all money fields */
  const strict = submit || (!!inv && inv.status === STATUS.SUBMITTED);
  const fields = normalizeInvoiceInput(payload, data, { strict });

  if (isNew) {
    inv = {
      id: `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      idempotencyKey: key,
      status: STATUS.DRAFT,
      number: null,
      createdAt: now, createdBy: actor.username,
      submittedAt: null, submittedBy: null,
      deletedAt: null, deletedBy: null,
    };
    invs.push(inv);
  }

  Object.assign(inv, fields);
  inv.updatedAt = now;
  inv.updatedBy = actor.username;

  /* 4) draft → final, exactly once, with the final invoice number */
  if (submit && inv.status === STATUS.DRAFT) {
    const meta = (data.meta = data.meta || {});
    meta.lastInvoiceNumber = Number(meta.lastInvoiceNumber || 0) + 1;
    inv.number = meta.lastInvoiceNumber;
    inv.status = STATUS.SUBMITTED;
    inv.submittedAt = now;
    inv.submittedBy = actor.username;
  }

  return { data, invoice: inv, deduped: false };
}

export function deleteInvoice(data, payload = {}, actor) {
  assertCan(actor, 'invoice.delete', 'حذف فاکتور فقط توسط مدیر امکان‌پذیر است.');
  const inv = (data.invoices || []).find(i => i.id === payload.id);
  if (!inv) throw new GateError('not_found', 'فاکتور یافت نشد.');
  if (inv.status === STATUS.VOID) throw new GateError('void', 'این فاکتور قبلاً حذف شده است.');
  const now = new Date().toISOString();
  inv.status = STATUS.VOID;
  inv.deletedAt = now;
  inv.deletedBy = actor.username;
  inv.updatedAt = now;
  inv.updatedBy = actor.username;
  return { data, invoice: inv };
}

/* ---------- whole-file validation (used by the GitHub Action) ---------- */
const isInt = v => Number.isInteger(v);
const isStr = v => typeof v === 'string';

/* Replace validateData() and add validateInvoices() */
export function validateData(data) {
  const bad = [];
  const p = m => bad.push(m);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['ریشه‌ی data.json باید یک شیء باشد.'];

  for (const k of ['users', 'carTypes', 'workers'])
    if (!Array.isArray(data[k])) p(`«${k}» باید آرایه باشد.`);
  if ('invoices' in data && !Array.isArray(data.invoices))
    p('«invoices» باید آرایه باشد (تومب‌استون خالی).');
  if (Array.isArray(data.invoices) && data.invoices.length > 0)
    p('«invoices» در data.json باید خالی باشد؛ فاکتورها باید در پوشه‌ی invoices/ باشند.');
  if (bad.length) return bad;

  /* users / carTypes / workers — same checks as before */
  const unames = new Set();
  data.users.forEach((u, i) => {
    if (!u || !isStr(u.username) || !u.username.trim()) p(`users[${i}].username نامعتبر است.`);
    else if (unames.has(u.username)) p(`نام کاربری تکراری: ${u.username}`);
    else unames.add(u.username);
    if (!u || !isStr(u.passHash) || !/^[0-9a-f]{64}$/i.test(u.passHash)) p(`users[${i}].passHash باید SHA-256 هگز باشد.`);
    if (!u || !Object.values(ROLES).includes(u.role)) p(`users[${i}].role نامعتبر است.`);
  });
  const tids = new Set();
  data.carTypes.forEach((t, i) => {
    if (!t || !isStr(t.id) || !t.id) p(`carTypes[${i}].id نامعتبر است.`);
    else if (tids.has(t.id)) p(`شناسه گروه تکراری: ${t.id}`); else tids.add(t.id);
    if (!t || !isStr(t.name) || !t.name.trim()) p(`carTypes[${i}].name نامعتبر است.`);
    const pr = (t && t.prices) || {};
    for (const k of ['wash', 'vacuum', 'wax'])
      if (!isInt(pr[k]) || pr[k] < 0) p(`carTypes[${i}].prices.${k} باید عدد صحیح نامنفی باشد.`);
    if (!t || !Array.isArray(t.cars)) { p(`carTypes[${i}].cars باید آرایه باشد.`); return; }
    const cids = new Set();
    t.cars.forEach((c, j) => {
      if (!c || !isStr(c.id) || !c.id) p(`carTypes[${i}].cars[${j}].id نامعتبر است.`);
      else if (cids.has(c.id)) p(`شناسه خودروی تکراری: ${c.id}`); else cids.add(c.id);
      if (!c || !isStr(c.name) || !c.name.trim()) p(`carTypes[${i}].cars[${j}].name نامعتبر است.`);
    });
  });
  const wids = new Set();
  data.workers.forEach((w, i) => {
    if (!w || !isStr(w.id) || !w.id) p(`workers[${i}].id نامعتبر است.`);
    else if (wids.has(w.id)) p(`شناسه کارگر تکراری: ${w.id}`); else wids.add(w.id);
    if (!w || !isStr(w.name) || !w.name.trim()) p(`workers[${i}].name نامعتبر است.`);
  });
  return bad;
}

export function validateInvoices(invoices) {
  const bad = [];
  if (!Array.isArray(invoices)) return ['invoices باید آرایه باشد.'];
  const p = m => bad.push(m);
  const iids = new Set(), nums = new Set();

  invoices.forEach((inv, i) => {
    const at = `[${i}]`;
    if (!inv || !isStr(inv.id) || !inv.id) { p(`${at}.id نامعتبر است.`); return; }
    if (iids.has(inv.id)) p(`${at}.id تکراری`); else iids.add(inv.id);
    if (!Object.values(STATUS).includes(inv.status)) { p(`${at}.status نامعتبر`); return; }
    for (const k of ['tip', 'discount', 'total', 'subtotal'])
      if (!isInt(inv[k]) || inv[k] < 0) p(`${at}.${k} باید عدد صحیح نامنفی باشد.`);
    if (!Array.isArray(inv.extras)) p(`${at}.extras باید آرایه باشد.`);
    else inv.extras.forEach((x, j) => {
      if (!x || !isStr(x.desc) || !x.desc.trim()) p(`${at}.extras[${j}].desc نامعتبر`);
      if (!x || !isInt(x.amount) || x.amount < 0) p(`${at}.extras[${j}].amount نامعتبر`);
    });
    const pr = inv.prices || {};
    for (const k of ['wash', 'vacuum', 'wax'])
      if (!isInt(pr[k]) || pr[k] < 0) p(`${at}.prices.${k} باید عدد صحیح نامنفی باشد.`);

    if (isInt(inv.subtotal) && inv.subtotal !== computeSubtotal(inv))
      p(`${at}.subtotal با اقلام هم‌خوانی ندارد.`);
    if (isInt(inv.total) && inv.total !== computeTotal(inv))
      p(`${at}.total با اقلام هم‌خوانی ندارد (${inv.total} ≠ ${computeTotal(inv)}).`);

    if (inv.status === STATUS.SUBMITTED) {
      if (!isInt(inv.number) || inv.number < 1) p(`${at}.number برای فاکتور نهایی الزامی است.`);
      else if (nums.has(inv.number)) p(`شماره فاکتور تکراری: ${inv.number}`);
      else nums.add(inv.number);
      if (!inv.submittedAt) p(`${at}.submittedAt برای فاکتور نهایی الزامی است.`);
    }
    if (inv.status === STATUS.DRAFT && inv.number != null) p(`${at}.number برای پیش‌فاکتور باید خالی باشد.`);
    if (inv.status === STATUS.VOID && !inv.deletedAt) p(`${at}.deletedAt برای فاکتور حذف‌شده الزامی است.`);
  });
  return bad;
}
