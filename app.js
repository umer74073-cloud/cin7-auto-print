require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.text({ type: '*/*', limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID);

app.get('/', (req, res) => {
  res.send('Cin7 auto print server is running');
});

app.post('/webhook/cin7', (req, res) => {
  console.log('Webhook received');

  // reply fast to Cin7
  res.status(200).send('OK');

  // process in background
  processPrint(req.body);
});

async function processPrint(rawBody) {
  try {
    const body = JSON.parse(rawBody);

    const downloadLink = body.DownloadLink;
    const invoiceNumber = body.InvoiceNumber || 'Invoice';

    if (!downloadLink) {
      console.log('ERROR: DownloadLink not found');
      return;
    }

    console.log('Downloading PDF...');
    const pdfResponse = await axios.get(downloadLink, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');

    console.log('Sending to PrintNode...');
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

    console.log('✅ PrintNode success:', printResponse.data);
  } catch (error) {
    console.log('❌ PRINT ERROR:');
    console.log(error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});