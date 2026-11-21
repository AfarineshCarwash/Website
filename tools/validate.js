import fs from 'node:fs';
import { validateData } from '../js/gate.js';

const file = process.argv[2] || 'data.json';
let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`❌ ${file} قابل خواندن نیست: ${e.message}`); process.exit(1); }

const problems = validateData(data);
if (problems.length) {
  console.error(`❌ ${file} نامعتبر است (${problems.length} مورد):`);
  for (const x of problems) console.error('  - ' + x);
  process.exit(1);
}
console.log(`✅ ${file} معتبر است.`);