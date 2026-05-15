require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.text({ type: '*/*', limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID);

const LOG_FILE = 'print-log.txt';
const PRINTED_FILE = 'printed-invoices.txt';

app.get('/', (req, res) => {
  res.send('Cin7 auto print server is running');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/webhook/cin7', (req, res) => {
  console.log('Webhook received');
  res.status(200).send('OK');
  processPrint(req.body);
});

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

function hasPrinted(invoiceNumber) {
  if (!fs.existsSync(PRINTED_FILE)) return false;

  const content = fs.readFileSync(PRINTED_FILE, 'utf8');
  const printedList = content.split('\n').map(x => x.trim()).filter(Boolean);

  return printedList.includes(invoiceNumber);
}

function markPrinted(invoiceNumber) {
  fs.appendFileSync(PRINTED_FILE, invoiceNumber + '\n');
}

async function processPrint(rawBody) {
  try {
    const body = JSON.parse(rawBody);

    const invoiceNumber = body.InvoiceNumber || 'Unknown-Invoice';
    const downloadLink = body.DownloadLink;

    if (!downloadLink) {
      writeLog(`ERROR | ${invoiceNumber} | DownloadLink missing`);
      return;
    }

    if (hasPrinted(invoiceNumber)) {
      writeLog(`SKIPPED DUPLICATE | ${invoiceNumber}`);
      return;
    }

    writeLog(`START PRINT | ${invoiceNumber}`);

    const pdfResponse = await axios.get(downloadLink, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');

    const printResponse = await axios.post(
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

    markPrinted(invoiceNumber);
    writeLog(`PRINT SUCCESS | ${invoiceNumber} | PrintNode Job ID: ${printResponse.data}`);
  } catch (error) {
    writeLog(`PRINT FAILED | ${error.response?.data || error.message}`);
  }
}

app.get('/logs', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) {
    return res.send('No logs yet');
  }

  const logs = fs.readFileSync(LOG_FILE, 'utf8');
  res.type('text/plain').send(logs);
});

app.get('/printed', (req, res) => {
  if (!fs.existsSync(PRINTED_FILE)) {
    return res.send('No printed invoices yet');
  }

  const printed = fs.readFileSync(PRINTED_FILE, 'utf8');
  res.type('text/plain').send(printed);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});