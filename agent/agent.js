const admin = require('firebase-admin');
const axios = require('axios');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:5002';
let SHOP_ID = process.env.SHOP_ID || 'default_shop';

// Config File path for local printer settings
const configFilePath = path.join(__dirname, 'config.json');

// Initialize local printer configuration + persisted shop settings
let localConfig = {
  shopId: process.env.SHOP_ID || 'default_shop',
  bwPrinter: '',
  colorPrinter: '',
  bwPrice: null,
  colorPrice: null,
  maxPagesPerBatch: 80,
  cooldownMin: 5,
  printers: {},
  upiId: ''
};

// Trackers for currently printing jobs on B&W and Color channels
let activeBwJob = null;
let activeColorJob = null;

function loadLocalConfig() {
  try {
    if (fs.existsSync(configFilePath)) {
      const data = fs.readFileSync(configFilePath, 'utf8');
      localConfig = JSON.parse(data);
      if (!localConfig.shopId) {
        localConfig.shopId = process.env.SHOP_ID || 'default_shop';
      }
      SHOP_ID = localConfig.shopId;
      console.log('Agent: Local printer config loaded:', localConfig);
    } else {
      saveLocalConfig();
    }
  } catch (err) {
    console.error('Agent: Failed to load config.json:', err.message);
  }
}

function saveLocalConfig() {
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(localConfig, null, 2), 'utf8');
    console.log('Agent: Local printer config saved.');
  } catch (err) {
    console.error('Agent: Failed to save config.json:', err.message);
  }
}

loadLocalConfig();

// Initialize Firebase Admin
const firebaseDbUrl = process.env.FIREBASE_DATABASE_URL;
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';

let db;

try {
  const absoluteServiceAccountPath = path.resolve(serviceAccountPath);
  if (fs.existsSync(absoluteServiceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(absoluteServiceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: firebaseDbUrl,
    });
    console.log('Agent: Firebase Admin initialized.');
    db = admin.database();
  } else {
    console.warn(`Agent: serviceAccountKey.json not found.`);
  }
} catch (error) {
  console.error('Agent: Firebase initialization failed.', error);
}

// Global list to keep track of active job statuses for the dashboard log
const printLogs = [];

// Watch database if initialized, else start polling local mock database server
let jobQueue = [];
let isPrinting = false;
let continuousPagesPrinted = 0; // Track continuous printed pages for cooldown limits

function sortJobQueue() {
  jobQueue.sort((a, b) => {
    const pA = a.jobData.priority ? 1 : 0;
    const pB = b.jobData.priority ? 1 : 0;
    if (pA !== pB) return pB - pA;
    const tA = a.jobData.createdAt || 0;
    const tB = b.jobData.createdAt || 0;
    return tA - tB;
  });
}

function enqueueJob(id, jobData) {
  const existing = jobQueue.find(j => j.id === id);
  if (!existing) {
    jobQueue.push({ id, jobData });
    console.log(`Agent Queue: Enqueued Job Token ${jobData.tokenNumber} (Priority: ${!!jobData.priority})`);
  } else {
    existing.jobData = jobData;
    console.log(`Agent Queue: Updated Job Token ${jobData.tokenNumber} (Priority: ${!!jobData.priority})`);
  }
  sortJobQueue();
  processNextJobInQueue();
}

async function processNextJobInQueue() {
  if (isPrinting) return;
  if (jobQueue.length === 0) {
    continuousPagesPrinted = 0;
    return;
  }

  // Check cooldown if continuous pages printed reaches or exceeds 80 pages
  const cooldownLimit = 80;
  if (continuousPagesPrinted >= cooldownLimit) {
    const cooldownMin = localConfig.cooldownMin || 5;
    const cooldownMs = cooldownMin * 60 * 1000;
    console.log(`\n================================================================`);
    console.log(`⚠️ PRINTER COOLDOWN ACTIVE: Printed ${continuousPagesPrinted} pages continuously.`);
    console.log(`Waiting for ${cooldownMin} minutes to prevent overheating...`);
    console.log(`================================================================\n`);

    isPrinting = true;
    setTimeout(() => {
      console.log(`\n🟢 Printer cooldown finished. Resuming queue processing...\n`);
      continuousPagesPrinted = 0;
      isPrinting = false;
      processNextJobInQueue();
    }, cooldownMs);
    return;
  }

  isPrinting = true;
  const nextJob = jobQueue.shift();

  try {
    await printJobDirect(nextJob.id, nextJob.jobData);
    // Track continuous printed pages
    const printedPages = (nextJob.jobData.totalPages || 0) * (nextJob.jobData.copies || 1);
    continuousPagesPrinted += printedPages;
    console.log(`Agent Queue: Cumulative pages printed continuously: ${continuousPagesPrinted}`);
  } catch (err) {
    console.error(`Agent Queue: Error processing job ${nextJob.id}:`, err);
  } finally {
    isPrinting = false;
    processNextJobInQueue();
  }
}

if (db) {
  startLiveListener();
} else {
  console.warn('Agent: Running in local demo database mode. Polling local mock backend server...');
  setInterval(pollMockCloudJobs, 3000);
}

// 1. Live RTDB Print Job Listener
function startLiveListener() {
  if (db) {
    try {
      db.ref('print_queue').off();
    } catch (e) {
      console.warn('Agent: Error clearing firebase listeners:', e.message);
    }
  }

  console.log(`Agent: Listening for pending print jobs on Firebase Cloud for Shop ID: ${SHOP_ID}...`);
  const queueRef = db.ref('print_queue');

  queueRef.orderByChild('status').equalTo('pending').on('child_added', (snapshot) => {
    const job = snapshot.val();
    if (job && job.shopId === SHOP_ID) {
      enqueueJob(snapshot.key, job);
    }
  });

  queueRef.orderByChild('status').equalTo('pending').on('child_changed', (snapshot) => {
    const job = snapshot.val();
    if (job && job.shopId === SHOP_ID) {
      enqueueJob(snapshot.key, job);
    }
  });
}

// Offline Polling loop to fetch print jobs from localhost:5002 when Firebase is offline
async function pollMockCloudJobs() {
  try {
    const response = await axios.get(`${BACKEND_API_URL}/api/jobs?shopId=${SHOP_ID}`);
    const jobs = response.data;
    if (jobs) {
      for (const [id, job] of Object.entries(jobs)) {
        if (job.status === 'pending') {
          enqueueJob(id, job);
        }
      }
    }
  } catch (err) {
    // Suppress warnings
  }
}

// Helper to stamp token number on the bottom right corner of each page in the PDF (font size 5)
async function stampTokenNumber(filePath, tokenNumber) {
  try {
    const fileBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(fileBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();

    for (const page of pages) {
      const { width, height } = page.getSize();
      const text = `${tokenNumber}`;
      const fontSize = 5;
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      
      // Stamp in bottom-right corner (10 units padding from edges)
      const x = width - textWidth - 10;
      const y = 10;

      page.drawText(text, {
        x: x,
        y: y,
        size: fontSize,
        font: font,
        color: rgb(0.2, 0.2, 0.2) // dark gray
      });
    }

    const modifiedBytes = await pdfDoc.save();
    fs.writeFileSync(filePath, modifiedBytes);
    console.log(`Agent: Stamped token ${tokenNumber} on PDF.`);
  } catch (err) {
    console.error("Agent: Failed to stamp token number on PDF:", err.message);
  }
}

// 2. Synchronous Sequential Print Job Processor (Handles downloads/prints sequentially)
async function printJobDirect(jobId, job) {
  let logItem = printLogs.find(l => l.id === jobId);
  if (!logItem) {
    logItem = {
      id: jobId,
      token: job.tokenNumber,
      printType: job.printType,
      copies: job.copies,
      sheets: job.totalPages,
      status: 'downloading',
      cost: job.cost || 0,
      timestamp: new Date().toLocaleTimeString()
    };
    printLogs.unshift(logItem);
  }

  console.log(`Agent: Processing Job ${job.tokenNumber} (${job.printType})...`);

  async function updateJobStatus(statusVal, extra = {}) {
    if (db) {
      await db.ref(`print_queue/${jobId}`).update({ status: statusVal, ...extra });
    } else {
      await axios.post(`${BACKEND_API_URL}/api/jobs/${jobId}/status`, { status: statusVal, ...extra });
    }
  }

  // Update ongoing print trackers
  const activeJobObj = {
    id: jobId,
    token: job.tokenNumber,
    fileUrl: job.fileUrl,
    printType: job.printType,
    copies: job.copies,
    sheets: job.totalPages
  };
  if (job.printType === 'color') {
    activeColorJob = activeJobObj;
  } else {
    activeBwJob = activeJobObj;
  }

  logItem.status = 'printing';
  try {
    await updateJobStatus('printing');
  } catch (err) {
    console.error('Agent: Failed to lock printing state on backend server:', err.message);
  }

  const tempFilePath = path.join(os.tmpdir(), `kiosk_${jobId}.pdf`);
  const isMockUrl = job.fileUrl.includes('mock-kiosk-bucket') || job.fileUrl.startsWith('data:');

  try {
    if (!isMockUrl) {
      // Download PDF
      const response = await axios({
        method: 'get',
        url: job.fileUrl,
        responseType: 'arraybuffer'
      });
      fs.writeFileSync(tempFilePath, response.data);
      
      // Stamp Token Number on PDF
      await stampTokenNumber(tempFilePath, job.tokenNumber);
    } else {
      // Mock PDF container file
      fs.writeFileSync(tempFilePath, '%PDF-1.4 mock document data');
    }

    // Fetch active printers configurations for routing
    let activePrinters = {};
    try {
      if (db) {
        const settingsSnap = await db.ref(`settings/${SHOP_ID}`).once('value');
        const settings = settingsSnap.val();
        if (settings) {
          activePrinters = settings.printers || {};
        }
      } else {
        const settingsResp = await axios.get(`${BACKEND_API_URL}/api/settings?shopId=${SHOP_ID}`);
        activePrinters = settingsResp.data.printers || {};
      }
    } catch (settingsErr) {
      console.error('Agent: Failed to fetch printers configuration for routing:', settingsErr);
    }

    // Determine printer routing based on printType and configured printer properties
    let selectedPrinterObj = null;
    const printersList = Object.values(activePrinters);
    
    if (job.printType === 'color') {
      selectedPrinterObj = printersList.find(p => p.colorMode === 'color') || printersList.find(p => p.colorMode === 'both');
    } else {
      selectedPrinterObj = printersList.find(p => p.colorMode === 'bw') || printersList.find(p => p.colorMode === 'both');
    }

    // Fallback if no printer matches color requirement but printers exist
    if (!selectedPrinterObj && printersList.length > 0) {
      selectedPrinterObj = printersList[0];
    }

    const targetPrinter = selectedPrinterObj ? selectedPrinterObj.name : null;
    console.log(`Agent: Routing Job ${job.tokenNumber} to Printer: ${targetPrinter || 'SYSTEM DEFAULT'}`);

    const printOptions = {
      copies: job.copies || 1,
      monochrome: job.printType === 'bw',
      paperSize: selectedPrinterObj?.paperSize || 'A4',
      scale: selectedPrinterObj?.scale || 'fit'
    };
    if (targetPrinter) {
      printOptions.printer = targetPrinter;
    }

    // Spool print job or save to mock prints folder in dev mode
    const mockPrintToFile = process.env.MOCK_PRINT_TO_FILE === 'true';
    if (mockPrintToFile) {
      const mockPrintsDir = path.join(__dirname, 'mock_prints');
      if (!fs.existsSync(mockPrintsDir)) {
        fs.mkdirSync(mockPrintsDir, { recursive: true });
      }
      const destPath = path.join(mockPrintsDir, `job_${jobId}_token_${job.tokenNumber}.pdf`);
      try {
        fs.copyFileSync(tempFilePath, destPath);
        console.log(`[MOCK PRINT] Stamped PDF successfully saved to: ${destPath}`);
        await new Promise(resolve => setTimeout(resolve, 1500)); // Short simulated delay
      } catch (copyErr) {
        console.error('[MOCK PRINT] Failed to copy stamped PDF:', copyErr.message);
      }
    } else {
      // Normal Spool print job
      try {
        if (!isMockUrl) {
          await ptp.print(tempFilePath, printOptions);
          console.log(`Agent: Spooler completed for Job ${job.tokenNumber}.`);
        } else {
          console.log(`Agent: Mock Spooler completed for Job ${job.tokenNumber}.`);
          await new Promise(resolve => setTimeout(resolve, 4000)); // Simulate printing delay
        }
      } catch (printErr) {
        console.error('Agent: Spooler error, falling back to mock wait.', printErr.message);
        await new Promise(resolve => setTimeout(resolve, 4000)); // Simulate mock printing delay
      }
    }

    // Clean up temp file
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }

    // Update backend status to completed
    await updateJobStatus('completed', { printedAt: Date.now() });

    logItem.status = 'completed';
    console.log(`Agent: Job ${job.tokenNumber} printed successfully.`);
  } catch (err) {
    console.error(`Agent: Printing failed for Job ${job.tokenNumber}:`, err);
    logItem.status = 'failed';
    
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }

    try {
      await updateJobStatus('failed', { errorMessage: err.message });
    } catch (dbErr) {}
  } finally {
    // Clear ongoing print trackers
    if (job.printType === 'color') {
      activeColorJob = null;
    } else {
      activeBwJob = null;
    }
  }
}

// --- EXPRESS SERVER & SHOPKEEPER DASHBOARD ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));

// POST: Forward login credentials to backend and switch local Shop ID context on success
app.post('/api/login', async (req, res) => {
  const { shopId, password, action = 'login' } = req.body;
  if (!shopId || !password) {
    return res.status(400).json({ error: 'Shop ID and password are required.' });
  }

  try {
    // Check if profile exists
    let profileExists = false;
    try {
      const profileResp = await axios.get(`${BACKEND_API_URL}/api/v1/profile/${shopId}`);
      profileExists = profileResp.data.passwordSet;
    } catch (e) {
      // quiet fallback
    }

    if (action === 'login' && !profileExists) {
      return res.status(400).json({ error: 'Shop ID is not registered. Please register first.' });
    }

    if (action === 'register' && profileExists) {
      return res.status(400).json({ error: 'Shop ID is already registered. Please log in.' });
    }

    const loginResp = await axios.post(`${BACKEND_API_URL}/api/v1/auth/login`, { shopId, password });
    if (loginResp.data.success) {
      // Update local agent configuration and switch SHOP_ID
      localConfig.shopId = shopId;
      saveLocalConfig();
      SHOP_ID = shopId;

      // Clear current print queue and reset printing state for the new shop
      jobQueue = [];
      isPrinting = false;

      // Restart live listener for the new SHOP_ID
      if (db) {
        startLiveListener();
      }

      console.log(`Agent: Successfully switched to Shop ID: ${SHOP_ID}`);
      res.json({
        success: true,
        token: loginResp.data.token,
        shopId: shopId,
        firstLogin: loginResp.data.firstLogin
      });
    } else {
      res.status(401).json({ error: 'Incorrect password.' });
    }
  } catch (err) {
    console.error('Agent login forward failed:', err.message);
    const status = err.response?.status || 500;
    const errMsg = err.response?.data?.error || err.message;
    res.status(status).json({ error: errMsg });
  }
});

// Serve Static dashboard file
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Fetch list of installed OS printers
app.get('/api/printers', async (_req, res) => {
  try {
    const printers = await ptp.getPrinters();
    res.json(printers);
  } catch (err) {
    console.error('Agent: Failed to fetch OS printers:', err.message);
    res.json([]);
  }
});

// GET: Proxy print documents to bypass local CORS limitations in browser previews
app.get('/api/pdf-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send('Missing url query parameter.');
  }

  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    });
    res.setHeader('Content-Type', 'application/pdf');
    response.data.pipe(res);
  } catch (err) {
    console.error('Agent: Failed to proxy preview PDF:', err.message);
    res.status(500).send('Proxy failed: ' + err.message);
  }
});

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      const family = iface.family;
      if ((family === 'IPv4' || family === 4) && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Fetch current local printer configurations, prices, and ongoing jobs
app.get('/api/config', async (_req, res) => {
  let bwPrice = 2;
  let colorPrice = 10;
  let maxPagesPerBatch = 80;
  let cooldownMin = 5;
  let printers = {};
  let upiId = '';
  let revenue = 0;
  let ordersCount = 0;

  try {
    if (db) {
      // Fetch prices and batch limits for the specific shop
      const settingsSnap = await db.ref(`settings/${SHOP_ID}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        bwPrice = settings.bwPrice ?? 2;
        colorPrice = settings.colorPrice ?? 10;
        maxPagesPerBatch = settings.maxPagesPerBatch ?? 80;
        cooldownMin = settings.cooldownMin ?? 5;
        printers = settings.printers ?? {};
        upiId = settings.upiId ?? '';
      }

      // Compute total finance details and build database-backed logs
      const queueSnap = await db.ref('print_queue').once('value');
      const queue = queueSnap.val();
      const dbLogs = [];
      if (queue) {
        Object.entries(queue).forEach(([id, job]) => {
          if (job.shopId === SHOP_ID) {
            if (job.status === 'completed' && job.cost) {
              revenue += job.cost;
              ordersCount++;
            }
            dbLogs.push({
              id: id,
              token: job.tokenNumber,
              printType: job.printType,
              copies: job.copies,
              sheets: job.totalPages,
              status: job.status,
              cost: job.cost || 0,
              timestamp: new Date(job.createdAt || Date.now()).toLocaleTimeString(),
              priority: job.priority || false
            });
          }
        });
        dbLogs.sort((a, b) => {
          const isACompleted = a.status === 'completed';
          const isBCompleted = b.status === 'completed';
          if (isACompleted && !isBCompleted) return 1;
          if (!isACompleted && isBCompleted) return -1;
          return b.id.localeCompare(a.id);
        });
      }
      printLogs.length = 0;
      printLogs.push(...dbLogs);
    } else {
      // Use locally persisted config first (survives restarts), then sync with backend
      bwPrice = localConfig.bwPrice;
      colorPrice = localConfig.colorPrice;
      maxPagesPerBatch = localConfig.maxPagesPerBatch ?? 80;
      cooldownMin = localConfig.cooldownMin ?? 5;
      printers = localConfig.printers ?? {};
      upiId = localConfig.upiId ?? '';
      // Also sync with backend in-memory store so checkout works correctly
      try {
        const payload = { shopId: SHOP_ID, bwPrice, colorPrice, maxPagesPerBatch, cooldownMin, printers, upiId };
        await axios.post(`${BACKEND_API_URL}/api/settings`, payload);
      } catch (e) { /* backend might not be ready yet, will sync next poll */ }

      const jobsResp = await axios.get(`${BACKEND_API_URL}/api/jobs?shopId=${SHOP_ID}`);
      const queue = jobsResp.data;
      const dbLogs = [];
      if (queue) {
        Object.entries(queue).forEach(([id, job]) => {
          if (job.status === 'completed' && job.cost) {
            revenue += job.cost;
            ordersCount++;
          }
          dbLogs.push({
            id: id,
            token: job.tokenNumber,
            printType: job.printType,
            copies: job.copies,
            sheets: job.totalPages,
            status: job.status,
            cost: job.cost || 0,
            timestamp: new Date(job.createdAt || Date.now()).toLocaleTimeString(),
            priority: job.priority || false
          });
        });
        dbLogs.sort((a, b) => {
          const isACompleted = a.status === 'completed';
          const isBCompleted = b.status === 'completed';
          if (isACompleted && !isBCompleted) return 1;
          if (!isACompleted && isBCompleted) return -1;
          return b.id.localeCompare(a.id);
        });
      }
      printLogs.length = 0;
      printLogs.push(...dbLogs);
    }
  } catch (err) {
    // Fallback quietly if connection isn't established yet
  }
  let qrCode = '';
  try {
    const profileResp = await axios.get(`${BACKEND_API_URL}/api/v1/profile/${SHOP_ID}`);
    qrCode = profileResp.data.qrCode || '';
  } catch (err) {
    // Fallback quietly if connection isn't established yet or backend offline
  }

  let localIp = 'localhost';
  try {
    localIp = getLocalIpAddress();
  } catch (ipErr) {}

  res.json({
    shopId: SHOP_ID,
    bwPrinter: localConfig.bwPrinter,
    colorPrinter: localConfig.colorPrinter,
    bwPrice,
    colorPrice,
    maxPagesPerBatch,
    cooldownMin,
    printers,
    upiId,
    revenue,
    ordersCount,
    logs: printLogs,
    activeBwJob,
    activeColorJob,
    qrCode,
    frontendUrl: process.env.PUBLIC_FRONTEND_URL 
      ? `${process.env.PUBLIC_FRONTEND_URL}/?shop=${SHOP_ID}`
      : `http://${localIp}:8080/?shop=${SHOP_ID}`
  });
});

// Save Local Printer Mappings (Write to config.json)
app.post('/api/config', (req, res) => {
  const { bwPrinter, colorPrinter } = req.body;
  
  localConfig.bwPrinter = bwPrinter || '';
  localConfig.colorPrinter = colorPrinter || '';
  
  saveLocalConfig();
  res.json({ success: true, message: 'Printer configuration saved successfully.' });
});

// Save Kiosk Price configuration (Write to Firebase /settings or config.json for persistence)
app.post('/api/settings', async (req, res) => {
  const { bwPrice, colorPrice, maxPagesPerBatch, cooldownMin, printers, upiId } = req.body;

  // Always persist to local config.json so settings survive restarts
  if (bwPrice !== undefined) localConfig.bwPrice = parseFloat(bwPrice);
  if (colorPrice !== undefined) localConfig.colorPrice = parseFloat(colorPrice);
  if (maxPagesPerBatch !== undefined) localConfig.maxPagesPerBatch = parseInt(maxPagesPerBatch) || 80;
  if (cooldownMin !== undefined) localConfig.cooldownMin = parseInt(cooldownMin) || 5;
  if (printers !== undefined) localConfig.printers = printers;
  if (upiId !== undefined) localConfig.upiId = upiId;
  saveLocalConfig();
  console.log('Agent: Settings persisted to config.json:', localConfig);

  if (!db) {
    try {
      const payload = { shopId: SHOP_ID, bwPrice: localConfig.bwPrice, colorPrice: localConfig.colorPrice, maxPagesPerBatch: localConfig.maxPagesPerBatch, cooldownMin: localConfig.cooldownMin };
      if (printers !== undefined) payload.printers = printers;
      if (upiId !== undefined) payload.upiId = upiId;
      await axios.post(`${BACKEND_API_URL}/api/settings`, payload);
      res.json({ success: true, message: 'Settings saved successfully.' });
    } catch (err) {
      // Even if backend call fails, local config is already saved
      res.json({ success: true, message: 'Settings saved to local disk.' });
    }
    return;
  }

  try {
    const updatePayload = {
      bwPrice: localConfig.bwPrice,
      colorPrice: localConfig.colorPrice,
      maxPagesPerBatch: localConfig.maxPagesPerBatch,
      cooldownMin: localConfig.cooldownMin
    };
    if (printers !== undefined) updatePayload.printers = printers;
    if (upiId !== undefined) updatePayload.upiId = upiId;
    await db.ref(`settings/${SHOP_ID}`).update(updatePayload);
    res.json({ success: true, message: 'Settings saved to Cloud.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write to database: ' + err.message });
  }
});

// POST: Proxy Set print job priority
app.post('/api/jobs/:id/priority', async (req, res) => {
  const { id } = req.params;
  const { priority } = req.body;

  if (!db) {
    try {
      await axios.post(`${BACKEND_API_URL}/api/jobs/${id}/priority`, { priority });
      res.json({ success: true, message: 'Priority updated successfully.' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update priority: ' + err.message });
    }
  } else {
    try {
      await db.ref(`print_queue/${id}`).update({ priority: !!priority });
      res.json({ success: true, message: 'Priority updated successfully.' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update priority: ' + err.message });
    }
  }
});

// POST: Proxy Set print job status (Allows shopkeeper to confirm direct UPI payments)
app.post('/api/jobs/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, paid } = req.body;

  if (!db) {
    try {
      await axios.post(`${BACKEND_API_URL}/api/jobs/${id}/status`, { status, paid });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update status on local mock cloud: ' + err.message });
    }
  } else {
    try {
      const updateData = { status };
      if (paid !== undefined) updateData.paid = paid;
      await db.ref(`print_queue/${id}`).update(updateData);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write status to database: ' + err.message });
    }
  }
});

// Start dashboard server on Port 3000
const DASHBOARD_PORT = 3000;
app.listen(DASHBOARD_PORT, () => {
  console.log(`================================================================`);
  console.log(`👨‍💼 SHOPKEEPER DASHBOARD IS READY!`);
  console.log(`Open dashboard in your browser: http://localhost:${DASHBOARD_PORT}`);
  console.log(`================================================================`);
});

// Simulated Loop Demo Mode
function runSimulatedDemoLoop() {
  console.log('Agent: Starting local demo mode...');
}
