require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.text({ type: 'text/*', limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;

/*
  CURRENT LIVE LOGIC STILL USES THIS HARDCODED MAPPING
*/
const PRINTER_MAP = {
  "Main Warehouse": 75444320,
  "Default": 75444320
};

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.send('Cin7 auto print server is running');
});

/*
  SERVE FIRST ONBOARDING PAGE
*/
app.get('/onboarding', (req, res) => {
  res.sendFile(path.join(__dirname, 'onboarding-page.html'));
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).send('OK');
  } catch (error) {
    res.status(500).send('DB ERROR');
  }
});

app.get('/status', async (req, res) => {
  try {
    const printedResult = await pool.query('SELECT COUNT(*) AS count FROM printed_invoices');
    const logsResult = await pool.query('SELECT COUNT(*) AS count FROM print_logs');
    const clientsResult = await pool.query('SELECT COUNT(*) AS count FROM clients');
    const printersResult = await pool.query('SELECT COUNT(*) AS count FROM client_printers');

    res.json({
      ok: true,
      printedInvoices: Number(printedResult.rows[0].count),
      logRows: Number(logsResult.rows[0].count),
      clientsCount: Number(clientsResult.rows[0].count),
      clientPrintersCount: Number(printersResult.rows[0].count),
      printerMappings: PRINTER_MAP
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/*
  SAVE CLIENT ROUTE
*/
app.post('/admin/clients', async (req, res) => {
  try {
    const { name, webhook_secret, printnode_api_key, is_active } = req.body;

    if (!name || !webhook_secret || !printnode_api_key) {
      return res.status(400).json({
        ok: false,
        error: 'name, webhook_secret and printnode_api_key are required'
      });
    }

    const existing = await pool.query(
      'SELECT id FROM clients WHERE webhook_secret = $1 LIMIT 1',
      [webhook_secret]
    );

    if (existing.rows.length > 0) {
      const updated = await pool.query(
        `
        UPDATE clients
        SET name = $1,
            printnode_api_key = $2,
            is_active = $3
        WHERE webhook_secret = $4
        RETURNING id, name, webhook_secret, is_active
        `,
        [name, printnode_api_key, is_active ?? true, webhook_secret]
      );

      return res.json({
        ok: true,
        message: 'Client updated successfully',
        client: updated.rows[0]
      });
    }

    const inserted = await pool.query(
      `
      INSERT INTO clients (name, webhook_secret, printnode_api_key, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, webhook_secret, is_active
      `,
      [name, webhook_secret, printnode_api_key, is_active ?? true]
    );

    return res.json({
      ok: true,
      message: 'Client created successfully',
      client: inserted.rows[0]
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/*
  SAVE PRINTERS ROUTE
*/
app.post('/admin/clients/:clientId/printers', async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const { printers } = req.body;

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: 'Valid clientId is required'
      });
    }

    const clientCheck = await pool.query(
      'SELECT id FROM clients WHERE id = $1 LIMIT 1',
      [clientId]
    );

    if (clientCheck.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Client not found'
      });
    }

    if (!Array.isArray(printers) || printers.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'At least one printer is required'
      });
    }

    if (printers.length > 5) {
      return res.status(400).json({
        ok: false,
        error: 'Maximum 5 printers allowed'
      });
    }

    const defaultCount = printers.filter(p => p.is_default === true).length;
    if (defaultCount !== 1) {
      return res.status(400).json({
        ok: false,
        error: 'Exactly one default printer is required'
      });
    }

    for (const printer of printers) {
      if (!printer.printer_id || !printer.priority_order) {
        return res.status(400).json({
          ok: false,
          error: 'Each printer must have printer_id and priority_order'
        });
      }
    }

    await pool.query(
      'DELETE FROM client_printers WHERE client_id = $1',
      [clientId]
    );

    for (const printer of printers) {
      await pool.query(
        `
        INSERT INTO client_printers
          (client_id, printer_id, printer_name, priority_order, is_default, is_active)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        `,
        [
          clientId,
          printer.printer_id,
          printer.printer_name || '',
          printer.priority_order,
          printer.is_default ?? false,
          printer.is_active ?? true
        ]
      );
    }

    return res.json({
      ok: true,
      message: 'Printers saved successfully'
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/*
  ONE-TIME SEED ROUTE
  CURRENTLY KEPT AS-IS
*/
app.get('/seed-first-client', async (req, res) => {
  try {
    const master = req.query.master;

    if (!WEBHOOK_SECRET || master !== WEBHOOK_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    const existing = await pool.query(
      'SELECT id, name, webhook_secret FROM clients WHERE webhook_secret = $1 LIMIT 1',
      ['Nexvista']
    );

    if (existing.rows.length > 0) {
      return res.json({
        ok: true,
        message: 'Client already exists',
        client: existing.rows[0]
      });
    }

    const inserted = await pool.query(
      `
      INSERT INTO clients (name, webhook_secret, printnode_api_key, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, name, webhook_secret
      `,
      ['Client A', 'Nexvista', PRINTNODE_API_KEY]
    );

    return res.json({
      ok: true,
      message: 'First client inserted successfully',
      client: inserted.rows[0]
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/webhook/cin7', (req, res) => {
  const providedSecret = req.query.secret;

  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    writeLog('UNAUTHORIZED WEBHOOK ATTEMPT');
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');
  processPrint(req.body);
});

async function initDb() {
  // CURRENT LIVE TABLES
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_logs (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      message TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS printed_invoices (
      id SERIAL PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // NEW MULTI-CLIENT TABLES
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      webhook_secret TEXT UNIQUE NOT NULL,
      printnode_api_key TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_printers (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      printer_id BIGINT NOT NULL,
      printer_name TEXT,
      priority_order INTEGER NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_printed_invoices (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      invoice_number TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (client_id, invoice_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_print_logs (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      invoice_number TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);

  try {
    await pool.query(
      'INSERT INTO print_logs (message) VALUES ($1)',
      [line]
    );
  } catch (error) {
    console.log('LOG DB ERROR:', error.message);
  }
}

async function hasPrinted(invoiceNumber) {
  const result = await pool.query(
    'SELECT 1 FROM printed_invoices WHERE invoice_number = $1 LIMIT 1',
    [invoiceNumber]
  );

  return result.rows.length > 0;
}

async function markPrinted(invoiceNumber) {
  await pool.query(
    'INSERT INTO printed_invoices (invoice_number) VALUES ($1) ON CONFLICT (invoice_number) DO NOTHING',
    [invoiceNumber]
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPrinterId(locationName) {
  if (locationName && PRINTER_MAP[locationName]) {
    return PRINTER_MAP[locationName];
  }

  return PRINTER_MAP["Default"];
}

async function sendToPrintNode(invoiceNumber, pdfBase64, printerId) {
  return axios.post(
    'https://api.printnode.com/printjobs',
    {
      printerId: printerId,
      title: `Cin7 Invoice ${invoiceNumber}`,
      contentType: 'pdf_base64',
      content: pdfBase64,
      source: 'Cin7 Auto Print'
    },
    {
      auth: {
        username: PRINTNODE_API_KEY,
        password: ''
      },
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );
}

async function processPrint(rawBody) {
  try {
    const body = JSON.parse(rawBody);

    const invoiceNumber = body.InvoiceNumber || 'Unknown-Invoice';
    const downloadLink = body.DownloadLink;
    const locationName = body.Location || body.LocationName || 'Default';
    const printerId = getPrinterId(locationName);

    if (!downloadLink) {
      await writeLog(`ERROR | ${invoiceNumber} | DownloadLink missing`);
      return;
    }

    if (await hasPrinted(invoiceNumber)) {
      await writeLog(`SKIPPED DUPLICATE | ${invoiceNumber}`);
      return;
    }

    await writeLog(`START PRINT | ${invoiceNumber} | Location: ${locationName} | Printer: ${printerId}`);

    const pdfResponse = await axios.get(downloadLink, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await writeLog(`PRINT ATTEMPT ${attempt} | ${invoiceNumber}`);

        const printResponse = await sendToPrintNode(invoiceNumber, pdfBase64, printerId);

        await markPrinted(invoiceNumber);
        await writeLog(`PRINT SUCCESS | ${invoiceNumber} | PrintNode Job ID: ${printResponse.data}`);
        return;
      } catch (error) {
        await writeLog(`PRINT ATTEMPT FAILED ${attempt} | ${invoiceNumber} | ${error.response?.data || error.message}`);

        if (attempt < MAX_RETRIES) {
          await writeLog(`RETRYING IN ${RETRY_DELAY_MS / 1000} SECONDS | ${invoiceNumber}`);
          await sleep(RETRY_DELAY_MS);
        } else {
          await writeLog(`PRINT FAILED FINAL | ${invoiceNumber}`);
        }
      }
    }
  } catch (error) {
    await writeLog(`PROCESS FAILED | ${error.response?.data || error.message}`);
  }
}

app.get('/logs', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT created_at, message FROM print_logs ORDER BY id DESC LIMIT 200'
    );

    const text = result.rows.map(r => r.message).join('\n');
    res.type('text/plain').send(text || 'No logs yet');
  } catch (error) {
    res.status(500).send('Log read failed');
  }
});

app.get('/printed', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT invoice_number FROM printed_invoices ORDER BY id DESC LIMIT 200'
    );

    const text = result.rows.map(r => r.invoice_number).join('\n');
    res.type('text/plain').send(text || 'No printed invoices yet');
  } catch (error) {
    res.status(500).send('Printed read failed');
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('DB INIT FAILED:', error.message);
    process.exit(1);
  });