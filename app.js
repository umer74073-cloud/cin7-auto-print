require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.text({ type: '*/*', limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.send('Cin7 auto print server is running');
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

    res.json({
      ok: true,
      printedInvoices: Number(printedResult.rows[0].count),
      logRows: Number(logsResult.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({
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

async function sendToPrintNode(invoiceNumber, pdfBase64) {
  return axios.post(
    'https://api.printnode.com/printjobs',
    {
      printerId: PRINTNODE_PRINTER_ID,
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

    if (!downloadLink) {
      await writeLog(`ERROR | ${invoiceNumber} | DownloadLink missing`);
      return;
    }

    if (await hasPrinted(invoiceNumber)) {
      await writeLog(`SKIPPED DUPLICATE | ${invoiceNumber}`);
      return;
    }

    await writeLog(`START PRINT | ${invoiceNumber}`);

    const pdfResponse = await axios.get(downloadLink, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await writeLog(`PRINT ATTEMPT ${attempt} | ${invoiceNumber}`);

        const printResponse = await sendToPrintNode(invoiceNumber, pdfBase64);

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