require("dotenv").config();
const path = require("path");
const XLSX = require("xlsx");
const { pool, init } = require("../db");

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/import-excel.js <path-to-xlsx>");
  process.exit(1);
}

// Maps source sheet name -> plant
const SHEET_TO_PLANT = {
  "Rai": "Rai",
  "RAI 2": "Rai",
  "RAI 3": "Rai",
  "Mumbai": "Mumbai",
  "Jaipur": "Jaipur",
  "HYD": "Hyderabad",
  "BLR": "Bangalore"
};

function normalizePodStatus(v) {
  const s = String(v || "").trim().toUpperCase();
  return s === "UPLOAD" ? "UPLOAD" : "PENDING";
}
function normalizeSubmissionStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "submitted" ? "Submitted" : "";
}
function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  return null;
}

function findHeaderRowAndCols(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (!rows[i]) continue;
    const row = Array.from(rows[i], c => String(c || "").trim().toLowerCase());
    const dateIdx = row.findIndex(c => c.startsWith("date"));
    const invIdx = row.findIndex(c => c.startsWith("invoice number"));
    if (dateIdx !== -1 && invIdx !== -1) {
      const cols = {};
      row.forEach((c, idx) => {
        if (c.startsWith("date")) cols.date = idx;
        else if (c.startsWith("invoice number")) cols.invoiceNumber = idx;
        else if (c.startsWith("customer name")) cols.customerName = idx;
        else if (c.startsWith("deliver to")) cols.deliverTo = idx;
        else if (c.startsWith("amount")) cols.amount = idx;
        else if (c.startsWith("pod status")) cols.podStatus = idx;
        else if (c.startsWith("submittion status") || c.startsWith("submission status")) cols.submissionStatus = idx;
      });
      return { headerRow: i, cols };
    }
  }
  return null;
}

async function importSheet(ws, plant, seenInvoiceNumbers) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const found = findHeaderRowAndCols(rows);
  if (!found) {
    console.warn(`  Could not find header row, skipping sheet`);
    return { inserted: 0, skipped: 0 };
  }
  const { headerRow, cols } = found;
  if (cols.date === undefined || cols.invoiceNumber === undefined || cols.customerName === undefined) {
    console.warn(`  Missing required columns, skipping sheet`);
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const invoiceNumber = String(row[cols.invoiceNumber] || "").trim();
    const dateStr = toDateStr(row[cols.date]);
    const customerName = String(row[cols.customerName] || "").trim();
    if (!invoiceNumber || !dateStr || !customerName) { skipped++; continue; }

    const key = `${plant}|${invoiceNumber}`;
    if (seenInvoiceNumbers.has(key)) { skipped++; continue; }
    seenInvoiceNumbers.add(key);

    const deliverTo = cols.deliverTo !== undefined ? String(row[cols.deliverTo] || "").trim() : "";
    const amount = cols.amount !== undefined ? Number(row[cols.amount]) || 0 : 0;
    const podStatus = normalizePodStatus(cols.podStatus !== undefined ? row[cols.podStatus] : "PENDING");
    const submissionStatus = normalizeSubmissionStatus(cols.submissionStatus !== undefined ? row[cols.submissionStatus] : "");

    await pool.query(
      `INSERT INTO invoices (plant, invoice_date, invoice_number, customer_name, deliver_to, amount, pod_status, submission_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (plant, invoice_number) DO NOTHING`,
      [plant, dateStr, invoiceNumber, customerName, deliverTo, amount, podStatus, submissionStatus]
    );
    inserted++;
  }

  return { inserted, skipped };
}

async function main() {
  await init();
  const wb = XLSX.readFile(path.resolve(filePath));
  const seenInvoiceNumbers = new Set();

  for (const [sheetName, plant] of Object.entries(SHEET_TO_PLANT)) {
    if (!wb.SheetNames.includes(sheetName)) {
      console.warn(`Sheet "${sheetName}" not found, skipping`);
      continue;
    }
    console.log(`Importing sheet "${sheetName}" -> plant "${plant}"...`);
    const ws = wb.Sheets[sheetName];
    const result = await importSheet(ws, plant, seenInvoiceNumbers);
    console.log(`  Inserted: ${result.inserted}, skipped: ${result.skipped}`);
  }

  await pool.end();
  console.log("Done.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
