require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.text({ type: 'text/*', limit: '20mb' }));

const PORT = process.env.PORT || 3000;
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
    const clientsResult = await pool.query('SELECT COUNT(*) AS count FROM clients');
    const printersResult = await pool.query('SELECT COUNT(*) AS count FROM client_printers');
    const printedResult = await pool.query('SELECT COUNT(*) AS count FROM client_printed_invoices');
    const logsResult = await pool.query('SELECT COUNT(*) AS count FROM client_print_logs');

    res.json({
      ok: true,
      clientsCount: Number(clientsResult.rows[0].count),
      clientPrintersCount: Number(printersResult.rows[0].count),
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

/*
  LIST ALL CLIENTS
*/
app.get('/admin/clients', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.webhook_secret,
        c.is_active,
        c.created_at,
        COUNT(cp.id) AS printers_count
      FROM clients c
      LEFT JOIN client_printers cp ON cp.client_id = c.id
      GROUP BY c.id
      ORDER BY c.id DESC
    `);

    return res.json({
      ok: true,
      clients: result.rows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/*
  CLIENT-SPECIFIC LOGS
*/
app.get('/admin/clients/:clientId/logs', async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: 'Valid clientId is required'
      });
    }

    const clientCheck = await pool.query(
      'SELECT id, name FROM clients WHERE id = $1 LIMIT 1',
      [clientId]
    );

    if (clientCheck.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Client not found'
      });
    }

    const logs = await pool.query(
      `
      SELECT created_at, invoice_number, message
      FROM client_print_logs
      WHERE client_id = $1
      ORDER BY id DESC
      LIMIT 200
      `,
      [clientId]
    );

    return res.json({
      ok: true,
      client: clientCheck.rows[0],
      logs: logs.rows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/*
  FETCH PRINTERS FROM PRINTNODE
*/
app.post('/admin/printnode/printers', async (req, res) => {
  try {
    const { printnode_api_key } = req.body;

    if (!printnode_api_key) {
      return res.status(400).json({
        ok: false,
        error: 'printnode_api_key is required'
      });
    }

    const response = await axios.get('https://api.printnode.com/printers', {
      auth: {
        username: printnode_api_key,
        password: ''
      },
      timeout: 30000
    });

    const printers = (response.data || []).map(p => ({
      printer_id: p.id,
      printer_name: p.name || '',
      computer_name: p.computer && p.computer.name ? p.computer.name : '',
      description: p.description || ''
    }));

    return res.json({
      ok: true,
      printers
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.response?.data || error.message
    });
  }
});

/*
  SAVE CLIENT
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
  SAVE PRINTERS
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

    await pool.query('DELETE FROM client_printers WHERE client_id = $1', [clientId]);

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
  DB-DRIVEN LIVE WEBHOOK
*/
app.post('/webhook/cin7', async (req, res) => {
  const providedSecret = req.query.secret;

  try {
    const client = await getClientBySecret(providedSecret);

    if (!client) {
      await writeSystemLog('UNAUTHORIZED WEBHOOK ATTEMPT');
      return res.status(401).send('Unauthorized');
    }

    res.status(200).send('OK');
    processPrint(req.body, client);
  } catch (error) {
    return res.status(500).send('Server error');
  }
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

async function getClientBySecret(secret) {
  const result = await pool.query(
    `
    SELECT id, name, webhook_secret, printnode_api_key, is_active
    FROM clients
    WHERE webhook_secret = $1 AND is_active = TRUE
    LIMIT 1
    `,
    [secret]
  );

  return result.rows[0] || null;
}

async function getClientPrinters(clientId) {
  const result = await pool.query(
    `
    SELECT id, printer_id, printer_name, priority_order, is_default, is_active
    FROM client_printers
    WHERE client_id = $1 AND is_active = TRUE
    ORDER BY priority_order ASC, id ASC
    `,
    [clientId]
  );

  return result.rows;
}

async function writeSystemLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);

  try {
    await pool.query(
      'INSERT INTO print_logs (message) VALUES ($1)',
      [line]
    );
  } catch (error) {
    console.log('SYSTEM LOG DB ERROR:', error.message);
  }
}

async function writeClientLog(clientId, invoiceNumber, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);

  try {
    await pool.query(
      `
      INSERT INTO client_print_logs (client_id, invoice_number, message)
      VALUES ($1, $2, $3)
      `,
      [clientId, invoiceNumber || null, line]
    );
  } catch (error) {
    console.log('CLIENT LOG DB ERROR:', error.message);
  }
}

async function hasPrintedForClient(clientId, invoiceNumber) {
  const result = await pool.query(
    `
    SELECT 1
    FROM client_printed_invoices
    WHERE client_id = $1 AND invoice_number = $2
    LIMIT 1
    `,
    [clientId, invoiceNumber]
  );

  return result.rows.length > 0;
}

async function markPrintedForClient(clientId, invoiceNumber) {
  await pool.query(
    `
    INSERT INTO client_printed_invoices (client_id, invoice_number)
    VALUES ($1, $2)
    ON CONFLICT (client_id, invoice_number) DO NOTHING
    `,
    [clientId, invoiceNumber]
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToPrintNode(invoiceNumber, pdfBase64, printerId, printnodeApiKey) {
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
        username: printnodeApiKey,
        password: ''
      },
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );
}

async function processPrint(rawBody, client) {
  try {
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;

    const invoiceNumber = body.InvoiceNumber || 'Unknown-Invoice';
    const downloadLink = body.DownloadLink;

    if (!downloadLink) {
      await writeClientLog(client.id, invoiceNumber, `ERROR | ${client.name} | DownloadLink missing`);
      return;
    }

    const printers = await getClientPrinters(client.id);

    if (!printers.length) {
      await writeClientLog(client.id, invoiceNumber, `ERROR | ${client.name} | No active printers configured`);
      return;
    }

    if (await hasPrintedForClient(client.id, invoiceNumber)) {
      await writeClientLog(client.id, invoiceNumber, `SKIPPED DUPLICATE | ${client.name} | ${invoiceNumber}`);
      return;
    }

    await writeClientLog(client.id, invoiceNumber, `START PRINT | ${client.name} | ${invoiceNumber}`);

    const pdfResponse = await axios.get(downloadLink, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');

    for (const printer of printers) {
      await writeClientLog(
        client.id,
        invoiceNumber,
        `TRY PRINTER | ${client.name} | ${invoiceNumber} | Printer: ${printer.printer_id} | Priority: ${printer.priority_order}`
      );

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await writeClientLog(
            client.id,
            invoiceNumber,
            `PRINT ATTEMPT ${attempt} | ${client.name} | ${invoiceNumber} | Printer: ${printer.printer_id}`
          );

          const printResponse = await sendToPrintNode(
            invoiceNumber,
            pdfBase64,
            printer.printer_id,
            client.printnode_api_key
          );

          await markPrintedForClient(client.id, invoiceNumber);

          await writeClientLog(
            client.id,
            invoiceNumber,
            `PRINT SUCCESS | ${client.name} | ${invoiceNumber} | Printer: ${printer.printer_id} | PrintNode Job ID: ${printResponse.data}`
          );

          return;
        } catch (error) {
          await writeClientLog(
            client.id,
            invoiceNumber,
            `PRINT ATTEMPT FAILED ${attempt} | ${client.name} | ${invoiceNumber} | Printer: ${printer.printer_id} | ${error.response?.data || error.message}`
          );

          if (attempt < MAX_RETRIES) {
            await writeClientLog(
              client.id,
              invoiceNumber,
              `RETRYING IN ${RETRY_DELAY_MS / 1000} SECONDS | ${client.name} | ${invoiceNumber} | Printer: ${printer.printer_id}`
            );
            await sleep(RETRY_DELAY_MS);
          }
        }
      }
    }

    await writeClientLog(client.id, invoiceNumber, `PRINT FAILED FINAL | ${client.name} | ${invoiceNumber} | All printers failed`);
  } catch (error) {
    await writeSystemLog(`PROCESS FAILED | ${error.response?.data || error.message}`);
  }
}

app.get('/logs', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT created_at, message
      FROM client_print_logs
      ORDER BY id DESC
      LIMIT 200
      `
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
      `
      SELECT client_id, invoice_number
      FROM client_printed_invoices
      ORDER BY id DESC
      LIMIT 200
      `
    );

    const text = result.rows.map(r => `client_id=${r.client_id} | invoice=${r.invoice_number}`).join('\n');
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