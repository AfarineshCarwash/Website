import { validateData, validateInvoices, STATUS } from '../js/gate.js';

const invDir = 'invoices';
const ARCHIVE_RE = /^archive-\d{4}\.json$/;
if (fs.existsSync(invDir)) {
  for (const name of fs.readdirSync(invDir)) {
    if (!name.endsWith('.json') || name === 'current.json') continue;
    const full = path.join(invDir, name);
    let j;
    try { j = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { problems.push(`${name}: JSON نامعتبر (${e.message})`); continue; }
    if (!Array.isArray(j.invoices)) { problems.push(`${name}: invoices باید آرایه باشد.`); continue; }
    for (const p of validateInvoices(j.invoices)) problems.push(`${name}: ${p}`);

    /* Archive integrity: only submitted/void, never drafts */
    if (ARCHIVE_RE.test(name)) {
      for (const inv of j.invoices) {
        if (inv.status === STATUS.DRAFT)
          problems.push(`${name}: پیش‌فاکتور نباید در آرشیو باشد (${inv.id}).`);
      }
    } else {
      problems.push(`${name}: نام فایل بایگانی باید archive-NNNN.json باشد.`);
    }
  }
}
