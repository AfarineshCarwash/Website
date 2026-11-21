import fs from 'node:fs';
import path from 'node:path';
import { validateData, validateInvoices, STATUS } from '../js/gate.js';

const dataFile = process.argv[2] || 'data.json';
let data;
try { data = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
catch (e) { console.error(`❌ ${dataFile} قابل خواندن نیست: ${e.message}`); process.exit(1); }

const problems = validateData(data);

const invDir = 'invoices';
if (fs.existsSync(invDir)) {
  for (const name of fs.readdirSync(invDir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(invDir, name);
    let j;
    try { j = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { problems.push(`${name}: JSON نامعتبر (${e.message})`); continue; }
    if (!Array.isArray(j.invoices)) { problems.push(`${name}: invoices باید آرایه باشد.`); continue; }
    for (const p of validateInvoices(j.invoices)) problems.push(`${name}: ${p}`);

    const m = name.match(/^invoices-(\d{4}-\d{2})\.json$/);
    if (m) {
      const month = m[1];
      for (const inv of j.invoices) {
        if (inv.status === STATUS.DRAFT) problems.push(`${name}: پیش‌فاکتور نباید در آرشیو باشد (${inv.id}).`);
        else {
          const im = new Date(inv.submittedAt || inv.createdAt).toISOString().slice(0, 7);
          if (im !== month) problems.push(`${name}: فاکتور ${inv.id} به ماه ${im} تعلق دارد.`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`❌ ${problems.length} مورد:`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('✅ داده‌ها و فاکتورها معتبرند.');
