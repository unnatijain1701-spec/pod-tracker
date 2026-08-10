require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { pool, init, PLANTS } = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function isValidPlant(plant) {
  return PLANTS.includes(plant);
}
function normalizePodStatus(v) {
  const s = String(v || "").trim().toUpperCase();
  return s === "UPLOAD" ? "UPLOAD" : "PENDING";
}
function normalizeSubmissionStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "submitted" ? "Submitted" : "";
}

// ---------- INVOICES ----------
app.get("/api/invoices", async (req, res) => {
  const { plant, from, to, status, q, page } = req.query;
  const conditions = [];
  const params = [];

  if (plant) {
    if (!isValidPlant(plant)) return res.status(400).json({ error: "invalid plant" });
    params.push(plant);
    conditions.push(`plant = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`invoice_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`invoice_date <= $${params.length}`);
  }
  if (status === "UPLOAD" || status === "PENDING") {
    params.push(status);
    conditions.push(`pod_status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(invoice_number ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR deliver_to ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const pageSize = 100;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageNum - 1) * pageSize;

  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM invoices ${where}`, params);
  const total = countRows[0].count;

  params.push(pageSize, offset);
  const { rows } = await pool.query(
    `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({ rows, total, page: pageNum, pageSize });
});

app.get("/api/invoices/summary", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      plant,
      COUNT(*)::int AS total_invoices,
      COUNT(*) FILTER (WHERE pod_status = 'UPLOAD')::int AS pod_uploaded,
      COUNT(*) FILTER (WHERE pod_status = 'PENDING')::int AS pod_pending,
      COALESCE(SUM(amount) FILTER (WHERE pod_status = 'PENDING'), 0) AS pending_value,
      COUNT(*) FILTER (WHERE submission_status = 'Submitted')::int AS submitted_count
    FROM invoices
    GROUP BY plant
  `);
  const byPlant = Object.fromEntries(rows.map(r => [r.plant, r]));

  const result = PLANTS.map(plant => {
    const r = byPlant[plant] || { total_invoices: 0, pod_uploaded: 0, pod_pending: 0, pending_value: 0, submitted_count: 0 };
    const total = r.total_invoices;
    return {
      plant,
      totalInvoices: total,
      podUploaded: r.pod_uploaded,
      podPending: r.pod_pending,
      pendingValue: Number(r.pending_value),
      submittedCount: r.submitted_count,
      submissionPct: total > 0 ? Math.round((r.submitted_count / total) * 1000) / 10 : 0,
      uploadPct: total > 0 ? Math.round((r.pod_uploaded / total) * 1000) / 10 : 0
    };
  });

  const overall = result.reduce((acc, r) => ({
    totalInvoices: acc.totalInvoices + r.totalInvoices,
    podUploaded: acc.podUploaded + r.podUploaded,
    podPending: acc.podPending + r.podPending,
    pendingValue: acc.pendingValue + r.pendingValue,
    submittedCount: acc.submittedCount + r.submittedCount
  }), { totalInvoices: 0, podUploaded: 0, podPending: 0, pendingValue: 0, submittedCount: 0 });
  overall.submissionPct = overall.totalInvoices > 0 ? Math.round((overall.submittedCount / overall.totalInvoices) * 1000) / 10 : 0;
  overall.uploadPct = overall.totalInvoices > 0 ? Math.round((overall.podUploaded / overall.totalInvoices) * 1000) / 10 : 0;

  res.json({ byPlant: result, overall });
});

app.post("/api/invoices", async (req, res) => {
  const { plant, invoiceDate, invoiceNumber, customerName, deliverTo, amount, podStatus, submissionStatus } = req.body;
  if (!plant || !isValidPlant(plant)) return res.status(400).json({ error: "valid plant is required" });
  if (!invoiceDate) return res.status(400).json({ error: "invoiceDate is required" });
  if (!invoiceNumber || !invoiceNumber.trim()) return res.status(400).json({ error: "invoiceNumber is required" });
  if (!customerName || !customerName.trim()) return res.status(400).json({ error: "customerName is required" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO invoices (plant, invoice_date, invoice_number, customer_name, deliver_to, amount, pod_status, submission_status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       RETURNING *`,
      [
        plant,
        invoiceDate,
        invoiceNumber.trim(),
        customerName.trim(),
        (deliverTo || "").trim(),
        Number(amount) || 0,
        normalizePodStatus(podStatus),
        normalizeSubmissionStatus(submissionStatus)
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "An invoice with this number already exists for this plant" });
    throw err;
  }
});

app.post("/api/invoices/bulk", async (req, res) => {
  const { plant, rows } = req.body;
  if (!plant || !isValidPlant(plant)) return res.status(400).json({ error: "valid plant is required" });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "rows array is required" });

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const invoiceDate = r.invoiceDate;
    const invoiceNumber = String(r.invoiceNumber || "").trim();
    const customerName = String(r.customerName || "").trim();
    if (!invoiceDate || !invoiceNumber || !customerName) {
      skipped++;
      errors.push({ row: i + 1, reason: "missing date, invoice number, or customer name" });
      continue;
    }
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO invoices (plant, invoice_date, invoice_number, customer_name, deliver_to, amount, pod_status, submission_status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (plant, invoice_number) DO NOTHING`,
        [
          plant,
          invoiceDate,
          invoiceNumber,
          customerName,
          String(r.deliverTo || "").trim(),
          Number(r.amount) || 0,
          normalizePodStatus(r.podStatus),
          normalizeSubmissionStatus(r.submissionStatus)
        ]
      );
      if (rowCount > 0) inserted++;
      else { skipped++; errors.push({ row: i + 1, reason: `duplicate invoice number ${invoiceNumber}` }); }
    } catch (err) {
      skipped++;
      errors.push({ row: i + 1, reason: err.message });
    }
  }

  res.json({ inserted, skipped, errors });
});

app.put("/api/invoices/:id", async (req, res) => {
  const { plant, invoiceDate, invoiceNumber, customerName, deliverTo, amount, podStatus, submissionStatus } = req.body;
  if (!plant || !isValidPlant(plant)) return res.status(400).json({ error: "valid plant is required" });
  if (!invoiceDate) return res.status(400).json({ error: "invoiceDate is required" });
  if (!invoiceNumber || !invoiceNumber.trim()) return res.status(400).json({ error: "invoiceNumber is required" });
  if (!customerName || !customerName.trim()) return res.status(400).json({ error: "customerName is required" });

  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET
        plant = $1, invoice_date = $2, invoice_number = $3, customer_name = $4,
        deliver_to = $5, amount = $6, pod_status = $7, submission_status = $8, updated_at = now()
       WHERE id = $9
       RETURNING *`,
      [
        plant,
        invoiceDate,
        invoiceNumber.trim(),
        customerName.trim(),
        (deliverTo || "").trim(),
        Number(amount) || 0,
        normalizePodStatus(podStatus),
        normalizeSubmissionStatus(submissionStatus),
        req.params.id
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Invoice not found" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "An invoice with this number already exists for this plant" });
    throw err;
  }
});

app.delete("/api/invoices/:id", async (req, res) => {
  await pool.query("DELETE FROM invoices WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

init()
  .then(() => {
    app.listen(PORT, () => console.log(`POD Tracker running on port ${PORT}`));
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
