require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/*', limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMeNow';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;
const SESSION_COOKIE = 'client_portal_session';
const SESSION_HOURS = 24 * 14;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function adminAuthorized(req) {
  const fromQuery = String(req.query.admin || '').trim();
  const fromHeader = String(req.headers['x-admin-password'] || '').trim();
  return fromQuery === ADMIN_PASSWORD || fromHeader === ADMIN_PASSWORD;
}

function requireAdmin(req, res, next) {
  if (!adminAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Admin authorization required' });
  }
  next();
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(value);
    }
  });
  return cookies;
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, originalHash] = stored.split(':');
  const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(checkHash, 'hex'), Buffer.from(originalHash, 'hex'));
}

function generateCode() {
  return crypto.randomBytes(12).toString('hex');
}

async function getLoggedInClient(req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const result = await pool.query(
    `
    SELECT c.id, c.name, c.email, c.webhook_secret, c.printnode_api_key, c.is_active, c.setup_completed
    FROM client_sessions s
    JOIN clients c ON c.id = s.client_id
    WHERE s.session_token = $1
      AND s.expires_at > NOW()
      AND c.is_active = TRUE
    LIMIT 1
    `,
    [token]
  );

  return result.rows[0] || null;
}

async function requireClient(req, res, next) {
  try {
    const client = await getLoggedInClient(req);
    if (!client) {
      return res.status(401).json({ ok: false, error: 'Login required' });
    }
    req.client = client;
    next();
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function writeSystemLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
}

async function writeClientLog(clientId, invoiceNumber, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  await pool.query(
    `INSERT INTO client_print_logs (client_id, invoice_number, message) VALUES ($1, $2, $3)`,
    [clientId, invoiceNumber || null, line]
  );
}

async function getClientBySecret(secret) {
  const result = await pool.query(
    `SELECT id, name, email, webhook_secret, printnode_api_key, is_active, setup_completed
     FROM clients
     WHERE webhook_secret = $1 AND is_active = TRUE
     LIMIT 1`,
    [secret]
  );
  return result.rows[0] || null;
}

async function getClientAnyBySecret(secret) {
  const result = await pool.query(
    `SELECT id, name, email, webhook_secret, printnode_api_key, is_active, setup_completed
     FROM clients
     WHERE webhook_secret = $1
     LIMIT 1`,
    [secret]
  );
  return result.rows[0] || null;
}

async function getClientPrinters(clientId) {
  const result = await pool.query(
    `SELECT id, printer_id, printer_name, priority_order, is_default, is_active
     FROM client_printers
     WHERE client_id = $1 AND is_active = TRUE
     ORDER BY priority_order ASC, id ASC`,
    [clientId]
  );
  return result.rows;
}

async function hasPrintedForClient(clientId, invoiceNumber) {
  const result = await pool.query(
    `SELECT 1 FROM client_printed_invoices WHERE client_id = $1 AND invoice_number = $2 LIMIT 1`,
    [clientId, invoiceNumber]
  );
  return result.rows.length > 0;
}

async function markPrintedForClient(clientId, invoiceNumber) {
  await pool.query(
    `INSERT INTO client_printed_invoices (client_id, invoice_number)
     VALUES ($1, $2)
     ON CONFLICT (client_id, invoice_number) DO NOTHING`,
    [clientId, invoiceNumber]
  );
}

async function sendToPrintNode(invoiceNumber, pdfBase64, printerId, printnodeApiKey) {
  return axios.post(
    'https://api.printnode.com/printjobs',
    {
      printerId,
      title: `Cin7 Invoice ${invoiceNumber}`,
      contentType: 'pdf_base64',
      content: pdfBase64,
      source: 'Cin7 Auto Print'
    },
    {
      auth: { username: printnodeApiKey, password: '' },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );
}

function normalizeBody(rawBody) {
  if (typeof rawBody === 'string') return JSON.parse(rawBody);
  return rawBody;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processPrint(rawBody, client) {
  try {
    const body = normalizeBody(rawBody);
    const invoiceNumber = body.InvoiceNumber || 'Unknown-Invoice';
    const downloadLink = body.DownloadLink;

    if (!downloadLink) {
      await writeClientLog(client.id, invoiceNumber, `ERROR | ${client.name || client.email} | DownloadLink missing`);
      return;
    }

    const printers = await getClientPrinters(client.id);
    if (!printers.length) {
      await writeClientLog(client.id, invoiceNumber, `ERROR | ${client.name || client.email} | No active printers configured`);
      return;
    }

    if (await hasPrintedForClient(client.id, invoiceNumber)) {
      await writeClientLog(client.id, invoiceNumber, `SKIPPED DUPLICATE | ${client.name || client.email} | ${invoiceNumber}`);
      return;
    }

    await writeClientLog(client.id, invoiceNumber, `START PRINT | ${client.name || client.email} | ${invoiceNumber}`);

    const pdfResponse = await axios.get(downloadLink, { responseType: 'arraybuffer', timeout: 30000 });
    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');

    for (const printer of printers) {
      await writeClientLog(client.id, invoiceNumber, `TRY PRINTER | ${client.name || client.email} | ${invoiceNumber} | Printer: ${printer.printer_id} | Priority: ${printer.priority_order}`);

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await writeClientLog(client.id, invoiceNumber, `PRINT ATTEMPT ${attempt} | ${client.name || client.email} | ${invoiceNumber} | Printer: ${printer.printer_id}`);
          const printResponse = await sendToPrintNode(invoiceNumber, pdfBase64, printer.printer_id, client.printnode_api_key);
          await markPrintedForClient(client.id, invoiceNumber);
          await writeClientLog(client.id, invoiceNumber, `PRINT SUCCESS | ${client.name || client.email} | ${invoiceNumber} | Printer: ${printer.printer_id} | PrintNode Job ID: ${JSON.stringify(printResponse.data)}`);
          return;
        } catch (error) {
          await writeClientLog(client.id, invoiceNumber, `PRINT ATTEMPT FAILED ${attempt} | ${client.name || client.email} | ${invoiceNumber} | Printer: ${printer.printer_id} | ${JSON.stringify(error.response?.data || error.message)}`);
          if (attempt < MAX_RETRIES) {
            await writeClientLog(client.id, invoiceNumber, `RETRYING IN ${RETRY_DELAY_MS / 1000} SECONDS | ${client.name || client.email} | ${invoiceNumber} | Printer: ${printer.printer_id}`);
            await sleep(RETRY_DELAY_MS);
          }
        }
      }
    }

    await writeClientLog(client.id, invoiceNumber, `PRINT FAILED FINAL | ${client.name || client.email} | ${invoiceNumber} | All printers failed`);
  } catch (error) {
    await writeSystemLog(`PROCESS FAILED | ${JSON.stringify(error.response?.data || error.message)}`);
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT DEFAULT '',
      email TEXT,
      password_hash TEXT,
      webhook_secret TEXT UNIQUE NOT NULL,
      printnode_api_key TEXT DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      setup_completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS setup_completed BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE clients ALTER COLUMN name SET DEFAULT ''`);
  await pool.query(`ALTER TABLE clients ALTER COLUMN printnode_api_key SET DEFAULT ''`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_email ON clients(email) WHERE email IS NOT NULL`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_sessions (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      session_token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// pages
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

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/client-portal', async (req, res) => {
  const client = await getLoggedInClient(req);
  if (!client) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'client-portal.html'));
});

app.get('/my-logs', async (req, res) => {
  const client = await getLoggedInClient(req);
  if (!client) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'my-logs.html'));
});

app.get('/onboarding', (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).send('Admin authorization required. Add ?admin=YOUR_ADMIN_PASSWORD');
  res.sendFile(path.join(__dirname, 'onboarding-page.html'));
});

app.get('/admin/clients/page', (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).send('Admin authorization required. Add ?admin=YOUR_ADMIN_PASSWORD');
  res.sendFile(path.join(__dirname, 'admin-clients.html'));
});

app.get('/client-logs', (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).send('Admin authorization required. Add ?admin=YOUR_ADMIN_PASSWORD');
  res.sendFile(path.join(__dirname, 'client-logs.html'));
});

// public/client auth routes
app.post('/client/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password are required' });
    }
    const cleanEmail = String(email).trim().toLowerCase();

    const existing = await pool.query('SELECT id FROM clients WHERE email = $1 LIMIT 1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ ok: false, error: 'This email is already registered' });
    }

    const passwordHash = hashPassword(password);
    const webhookSecret = generateCode();

    const inserted = await pool.query(
      `
      INSERT INTO clients (name, email, password_hash, webhook_secret, printnode_api_key, is_active, setup_completed)
      VALUES ('', $1, $2, $3, '', TRUE, FALSE)
      RETURNING id, email, webhook_secret, setup_completed
      `,
      [cleanEmail, passwordHash, webhookSecret]
    );

    res.json({ ok: true, message: 'Account created successfully', client: inserted.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/client/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password are required' });
    }

    const clientResult = await pool.query(
      `
      SELECT id, email, password_hash, is_active
      FROM clients
      WHERE email = $1
      LIMIT 1
      `,
      [String(email).trim().toLowerCase()]
    );

    if (clientResult.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const client = clientResult.rows[0];
    if (!client.is_active) {
      return res.status(403).json({ ok: false, error: 'Account is inactive' });
    }

    if (!verifyPassword(password, client.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const sessionToken = generateCode() + generateCode();
    await pool.query(
      `
      INSERT INTO client_sessions (client_id, session_token, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '${SESSION_HOURS} hours')
      `,
      [client.id, sessionToken]
    );

    setSessionCookie(res, sessionToken);
    res.json({ ok: true, message: 'Login successful' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/client/logout', async (req, res) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      await pool.query('DELETE FROM client_sessions WHERE session_token = $1', [token]);
    }
    clearSessionCookie(res);
    res.json({ ok: true, message: 'Logged out' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/client/me', requireClient, async (req, res) => {
  try {
    const printers = await getClientPrinters(req.client.id);
    res.json({
      ok: true,
      client: {
        id: req.client.id,
        name: req.client.name,
        email: req.client.email,
        webhook_secret: req.client.webhook_secret,
        is_active: req.client.is_active,
        setup_completed: req.client.setup_completed
      },
      printers
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/client/setup-status', requireClient, async (req, res) => {
  try {
    const printers = await getClientPrinters(req.client.id);
    res.json({
      ok: true,
      client: {
        id: req.client.id,
        name: req.client.name,
        email: req.client.email,
        webhook_secret: req.client.webhook_secret,
        setup_completed: req.client.setup_completed
      },
      printers
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/client/fetch-printers', requireClient, async (req, res) => {
  try {
    if (req.client.setup_completed) {
      return res.status(403).json({ ok: false, error: 'Setup already completed. Contact administrator for changes.' });
    }

    const { printnode_api_key } = req.body;
    if (!printnode_api_key) {
      return res.status(400).json({ ok: false, error: 'printnode_api_key is required' });
    }

    const response = await axios.get('https://api.printnode.com/printers', {
      auth: { username: printnode_api_key, password: '' },
      timeout: 30000
    });

    const printers = (response.data || []).map(p => ({
      printer_id: p.id,
      printer_name: p.name || '',
      computer_name: p.computer && p.computer.name ? p.computer.name : '',
      description: p.description || ''
    }));

    res.json({ ok: true, printers });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.response?.data || error.message });
  }
});

app.post('/client/complete-setup', requireClient, async (req, res) => {
  try {
    if (req.client.setup_completed) {
      return res.status(403).json({ ok: false, error: 'Setup already completed. Contact administrator for changes.' });
    }

    const { name, printnode_api_key, printers } = req.body;
    if (!name || !printnode_api_key) {
      return res.status(400).json({ ok: false, error: 'name and printnode_api_key are required' });
    }
    if (!Array.isArray(printers) || printers.length === 0) {
      return res.status(400).json({ ok: false, error: 'At least one printer is required' });
    }
    if (printers.length > 5) {
      return res.status(400).json({ ok: false, error: 'Maximum 5 printers allowed' });
    }
    const defaultCount = printers.filter(p => p.is_default === true).length;
    if (defaultCount !== 1) {
      return res.status(400).json({ ok: false, error: 'Exactly one primary printer is required' });
    }

    for (const printer of printers) {
      if (!printer.printer_id || !printer.priority_order) {
        return res.status(400).json({ ok: false, error: 'Each printer must have printer_id and priority_order' });
      }
    }

    await pool.query(
      `
      UPDATE clients
      SET name = $1,
          printnode_api_key = $2,
          setup_completed = TRUE
      WHERE id = $3
      `,
      [name, printnode_api_key, req.client.id]
    );

    await pool.query('DELETE FROM client_printers WHERE client_id = $1', [req.client.id]);
    for (const printer of printers) {
      await pool.query(
        `
        INSERT INTO client_printers
          (client_id, printer_id, printer_name, priority_order, is_default, is_active)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        `,
        [
          req.client.id,
          printer.printer_id,
          printer.printer_name || '',
          printer.priority_order,
          printer.is_default ?? false,
          printer.is_active ?? true
        ]
      );
    }

    await writeClientLog(req.client.id, null, `CLIENT SETUP COMPLETED | ${name}`);
    res.json({ ok: true, message: 'Setup completed successfully' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/client/my-logs', requireClient, async (req, res) => {
  try {
    const logs = await pool.query(
      `
      SELECT created_at, invoice_number, message
      FROM client_print_logs
      WHERE client_id = $1
      ORDER BY id DESC
      LIMIT 200
      `,
      [req.client.id]
    );

    res.json({
      ok: true,
      client: {
        id: req.client.id,
        name: req.client.name,
        email: req.client.email
      },
      logs: logs.rows
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// admin routes
app.get('/admin/clients', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.email,
        c.webhook_secret,
        c.is_active,
        c.setup_completed,
        c.created_at,
        COUNT(cp.id) AS printers_count
      FROM clients c
      LEFT JOIN client_printers cp ON cp.client_id = c.id
      GROUP BY c.id
      ORDER BY c.id DESC
      `
    );

    res.json({ ok: true, clients: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/admin/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ ok: false, error: 'Valid clientId is required' });

    const clientResult = await pool.query(
      `
      SELECT id, name, email, webhook_secret, printnode_api_key, is_active, setup_completed, created_at
      FROM clients
      WHERE id = $1
      LIMIT 1
      `,
      [clientId]
    );
    if (clientResult.rows.length === 0) return res.status(404).json({ ok: false, error: 'Client not found' });

    const printersResult = await pool.query(
      `
      SELECT id, printer_id, printer_name, priority_order, is_default, is_active, created_at
      FROM client_printers
      WHERE client_id = $1
      ORDER BY priority_order ASC, id ASC
      `,
      [clientId]
    );

    res.json({ ok: true, client: clientResult.rows[0], printers: printersResult.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/admin/clients', requireAdmin, async (req, res) => {
  try {
    const { name, email, webhook_secret, printnode_api_key, is_active, setup_completed } = req.body;
    if (!webhook_secret) return res.status(400).json({ ok: false, error: 'webhook_secret is required' });

    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (cleanEmail) {
      const emailCheck = await pool.query('SELECT id FROM clients WHERE email = $1 LIMIT 1', [cleanEmail]);
      if (emailCheck.rows.length > 0) return res.status(400).json({ ok: false, error: 'email already used by another client' });
    }

    const inserted = await pool.query(
      `
      INSERT INTO clients (name, email, webhook_secret, printnode_api_key, is_active, setup_completed)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, email, webhook_secret, is_active, setup_completed
      `,
      [name || '', cleanEmail, webhook_secret, printnode_api_key || '', is_active ?? true, setup_completed ?? false]
    );

    res.json({ ok: true, message: 'Client created successfully', client: inserted.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/admin/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const { name, email, webhook_secret, printnode_api_key, is_active, setup_completed } = req.body;
    if (!clientId) return res.status(400).json({ ok: false, error: 'Valid clientId is required' });
    if (!webhook_secret) return res.status(400).json({ ok: false, error: 'webhook_secret is required' });

    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (cleanEmail) {
      const conflictEmail = await pool.query('SELECT id FROM clients WHERE email = $1 AND id <> $2 LIMIT 1', [cleanEmail, clientId]);
      if (conflictEmail.rows.length > 0) return res.status(400).json({ ok: false, error: 'email already used by another client' });
    }

    const conflictSecret = await pool.query('SELECT id FROM clients WHERE webhook_secret = $1 AND id <> $2 LIMIT 1', [webhook_secret, clientId]);
    if (conflictSecret.rows.length > 0) return res.status(400).json({ ok: false, error: 'webhook_secret already used by another client' });

    const updated = await pool.query(
      `
      UPDATE clients
      SET name = $1,
          email = $2,
          webhook_secret = $3,
          printnode_api_key = $4,
          is_active = $5,
          setup_completed = $6
      WHERE id = $7
      RETURNING id, name, email, webhook_secret, printnode_api_key, is_active, setup_completed
      `,
      [name || '', cleanEmail, webhook_secret, printnode_api_key || '', is_active ?? true, setup_completed ?? false, clientId]
    );

    if (updated.rows.length === 0) return res.status(404).json({ ok: false, error: 'Client not found' });
    res.json({ ok: true, message: 'Client updated successfully', client: updated.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/admin/clients/:clientId/status', requireAdmin, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const { is_active } = req.body;
    if (!clientId) return res.status(400).json({ ok: false, error: 'Valid clientId is required' });
    if (typeof is_active !== 'boolean') return res.status(400).json({ ok: false, error: 'is_active must be boolean' });

    const updated = await pool.query(
      `UPDATE clients SET is_active = $1 WHERE id = $2 RETURNING id, name, is_active`,
      [is_active, clientId]
    );
    if (updated.rows.length === 0) return res.status(404).json({ ok: false, error: 'Client not found' });
    res.json({ ok: true, message: 'Client status updated', client: updated.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/admin/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ ok: false, error: 'Valid clientId is required' });

    const deleted = await pool.query(`DELETE FROM clients WHERE id = $1 RETURNING id, name`, [clientId]);
    if (deleted.rows.length === 0) return res.status(404).json({ ok: false, error: 'Client not found' });
    res.json({ ok: true, message: 'Client deleted successfully', client: deleted.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/admin/clients/:clientId/printers', requireAdmin, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const { printers } = req.body;
    if (!clientId) return res.status(400).json({ ok: false, error: 'Valid clientId is required' });

    const clientCheck = await pool.query('SELECT id FROM clients WHERE id = $1 LIMIT 1', [clientId]);
    if (clientCheck.rows.length === 0) return res.status(404).json({ ok: false, error: 'Client not found' });

    if (!Array.isArray(printers) || printers.length === 0) return res.status(400).json({ ok: false, error: 'At least one printer is required' });
    if (printers.length > 5) return res.status(400).json({ ok: false, error: 'Maximum 5 printers allowed' });

    const defaultCount = printers.filter(p => p.is_default === true).length;
    if (defaultCount !== 1) return res.status(400).json({ ok: false, error: 'Exactly one default printer is required' });

    for (const printer of printers) {
      if (!printer.printer_id || !printer.priority_order) {
        return res.status(400).json({ ok: false, error: 'Each printer must have printer_id and priority_order' });
      }
    }

    await pool.query('DELETE FROM client_printers WHERE client_id = $1', [clientId]);
    for (const printer of printers) {
      await pool.query(
        `
        INSERT INTO client_printers (client_id, printer_id, printer_name, priority_order, is_default, is_active)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [clientId, printer.printer_id, printer.printer_name || '', printer.priority_order, printer.is_default ?? false, printer.is_active ?? true]
      );
    }

    res.json({ ok: true, message: 'Printers saved successfully' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/admin/printnode/printers', requireAdmin, async (req, res) => {
  try {
    const { printnode_api_key } = req.body;
    if (!printnode_api_key) return res.status(400).json({ ok: false, error: 'printnode_api_key is required' });

    const response = await axios.get('https://api.printnode.com/printers', {
      auth: { username: printnode_api_key, password: '' },
      timeout: 30000
    });

    const printers = (response.data || []).map(p => ({
      printer_id: p.id,
      printer_name: p.name || '',
      computer_name: p.computer && p.computer.name ? p.computer.name : '',
      description: p.description || ''
    }));

    res.json({ ok: true, printers });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.response?.data || error.message });
  }
});

app.get('/admin/clients/:clientId/logs', requireAdmin, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ ok: false, error: 'Valid clientId is required' });

    const clientCheck = await pool.query('SELECT id, name FROM clients WHERE id = $1 LIMIT 1', [clientId]);
    if (clientCheck.rows.length === 0) return res.status(404).json({ ok: false, error: 'Client not found' });

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

    res.json({ ok: true, client: clientCheck.rows[0], logs: logs.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// webhook
app.post('/webhook/cin7', async (req, res) => {
  const providedSecret = String(req.query.secret || '').trim();

  try {
    const client = await getClientBySecret(providedSecret);
    if (!client) {
      await writeSystemLog('UNAUTHORIZED WEBHOOK ATTEMPT');
      return res.status(401).send('Unauthorized');
    }

    res.status(200).send('OK');
    processPrint(req.body, client);
  } catch (error) {
    res.status(500).send('Server error');
  }
});

// admin raw views
app.get('/logs', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT created_at, message FROM client_print_logs ORDER BY id DESC LIMIT 200`);
    const text = result.rows.map(r => r.message).join('\n');
    res.type('text/plain').send(text || 'No logs yet');
  } catch (error) {
    res.status(500).send('Log read failed');
  }
});

app.get('/printed', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT client_id, invoice_number FROM client_printed_invoices ORDER BY id DESC LIMIT 200`);
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
