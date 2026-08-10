const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const PLANTS = ["Rai", "Jaipur", "Bangalore", "Mumbai", "Hyderabad"];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      plant TEXT NOT NULL,
      invoice_date DATE NOT NULL,
      invoice_number TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      deliver_to TEXT DEFAULT '',
      amount NUMERIC NOT NULL DEFAULT 0,
      pod_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (pod_status IN ('UPLOAD','PENDING')),
      submission_status TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      batch_id UUID,
      UNIQUE (plant, invoice_number)
    );
  `);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS batch_id UUID;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS invoices_plant_date_idx ON invoices (plant, invoice_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (pod_status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS invoices_batch_id_idx ON invoices (batch_id);`);
}

module.exports = { pool, init, PLANTS };
