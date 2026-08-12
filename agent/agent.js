const admin = require('firebase-admin');
const axios = require('axios');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// pkg-compatible base directory:
// When running as a compiled .exe, process.execPath is the .exe itself.
// We store mutable files (config, journal, .env) next to the .exe, not inside the bundle.
const IS_PKG = typeof process.pkg !== 'undefined';
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;

// Load .env from alongside the .exe (or script dir in dev mode)
require('dotenv').config({ path: path.join(BASE_DIR, '.env') });

const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:5002';
let SHOP_ID = process.env.SHOP_ID || 'default_shop';

// Mutable config/journal files live next to the .exe on disk
const configFilePath = path.join(BASE_DIR, 'config.json');

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
  upiId: '',
  sessionToken: ''
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

let sessionToken = localConfig.sessionToken || '';

const journalFilePath = path.join(BASE_DIR, 'jobs_journal.json');

function loadJournal() {
  try {
    if (fs.existsSync(journalFilePath)) {
      return JSON.parse(fs.readFileSync(journalFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Agent Journal: Failed to read jobs_journal.json:', err.message);
  }
  return {};
}

function saveJournal(journal) {
  try {
    fs.writeFileSync(journalFilePath, JSON.stringify(journal, null, 2), 'utf8');
  } catch (err) {
    console.error('Agent Journal: Failed to write jobs_journal.json:', err.message);
  }
}

function journalUpdate(jobId, jobData, localStatus, remoteStatus, extra = {}, pendingSync = false) {
  const journal = loadJournal();
  
  if (!journal[jobId]) {
    journal[jobId] = {
      id: jobId,
      jobData: jobData,
      localStatus: localStatus,
      remoteStatus: remoteStatus,
      extra: extra,
      pendingSync: pendingSync,
      updatedAt: Date.now()
    };
  } else {
    if (jobData) journal[jobId].jobData = jobData;
    journal[jobId].localStatus = localStatus;
    journal[jobId].remoteStatus = remoteStatus;
    journal[jobId].extra = { ...journal[jobId].extra, ...extra };
    journal[jobId].pendingSync = pendingSync;
    journal[jobId].updatedAt = Date.now();
  }

  saveJournal(journal);
}

async function syncJobStatusUpdate(jobId, statusVal, extra = {}) {
  const journal = loadJournal();
  const job = journal[jobId];
  const jobData = job ? job.jobData : null;
  
  // Save locally first with pendingSync flag
  journalUpdate(jobId, jobData, statusVal, job?.remoteStatus || 'unknown', extra, true);

  try {
    if (db) {
      await db.ref(`print_queue/${jobId}`).update({ status: statusVal, ...extra });
    } else {
      await axios.post(`${BACKEND_API_URL}/api/jobs/${jobId}/status`, { status: statusVal, ...extra });
    }
    // Remote success: clear pendingSync
    journalUpdate(jobId, jobData, statusVal, statusVal, extra, false);
    console.log(`Agent Journal: Synced status '${statusVal}' for job ${jobId} to cloud.`);
  } catch (err) {
    console.warn(`Agent Journal: Offline or failed to sync status '${statusVal}' for job ${jobId}. Buffered locally.`);
  }
}

async function syncJobPriorityUpdate(jobId, priorityVal) {
  const journal = loadJournal();
  const job = journal[jobId];
  if (job && job.jobData) {
    job.jobData.priority = priorityVal;
    saveJournal(journal);
    
    // Save locally first with pendingSync flag
    journalUpdate(jobId, job.jobData, job.localStatus, job.remoteStatus, {}, true);
  }

  try {
    if (db) {
      await db.ref(`print_queue/${jobId}`).update({ priority: priorityVal });
    } else {
      await axios.post(`${BACKEND_API_URL}/api/jobs/${jobId}/priority`, { priority: priorityVal });
    }
    // Remote success
    const updatedJournal = loadJournal();
    if (updatedJournal[jobId]) {
      updatedJournal[jobId].pendingSync = false;
      saveJournal(updatedJournal);
    }
    console.log(`Agent Journal: Synced priority '${priorityVal}' for job ${jobId} to cloud.`);
  } catch (err) {
    console.warn(`Agent Journal: Offline or failed to sync priority for job ${jobId}. Buffered locally.`);
  }
}

function startJournalSyncLoop() {
  setInterval(async () => {
    const journal = loadJournal();
    let hasUpdates = false;

    for (const [jobId, entry] of Object.entries(journal)) {
      if (entry.pendingSync) {
        try {
          if (db) {
            await db.ref(`print_queue/${jobId}`).update({
              status: entry.localStatus,
              priority: !!entry.jobData?.priority,
              ...entry.extra
            });
          } else {
            await axios.post(`${BACKEND_API_URL}/api/jobs/${jobId}/status`, {
              status: entry.localStatus,
              ...entry.extra
            });
            await axios.post(`${BACKEND_API_URL}/api/jobs/${jobId}/priority`, {
              priority: !!entry.jobData?.priority
            });
          }
          entry.remoteStatus = entry.localStatus;
          entry.pendingSync = false;
          hasUpdates = true;
          console.log(`Agent Journal Sync: Successfully synced job ${jobId} status to cloud.`);
        } catch (err) {
          // Suppress error to avoid log flood during connection down periods
        }
      }
    }

    if (hasUpdates) {
      saveJournal(journal);
    }
  }, 10000);
}

function recoverJobsFromJournal() {
  const journal = loadJournal();
  let count = 0;
  Object.entries(journal).forEach(([id, entry]) => {
    if (entry.localStatus === 'pending' || entry.localStatus === 'printing') {
      enqueueJob(id, entry.jobData);
      count++;
    }
  });
  if (count > 0) {
    console.log(`Agent: Recovered and re-enqueued ${count} jobs from local journal.`);
  }
}

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

// Initialize Supabase Client
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
let supabase;

if (supabaseUrl && supabaseAnonKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
    console.log('Agent: Supabase Client initialized.');
  } catch (err) {
    console.error('Agent: Failed to initialize Supabase client:', err.message);
  }
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

  // Persist to local journal
  journalUpdate(id, jobData, jobData.status || 'pending', jobData.status || 'pending');

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

// Start offline sync and recover journal queue on launch
startJournalSyncLoop();
recoverJobsFromJournal();

let realtimeChannel;

if (supabase || db) {
  startLiveListener();
} else {
  console.warn('Agent: Running in local demo database mode. Polling local mock backend server...');
  setInterval(pollMockCloudJobs, 3000);
}

function mapSupabaseJob(row) {
  return {
    id: row.id,
    fileUrl: row.file_url,
    printType: row.print_type,
    totalPages: parseInt(row.total_pages),
    copies: parseInt(row.copies),
    tokenNumber: row.token_number,
    status: row.status,
    paid: row.paid,
    cost: parseFloat(row.cost),
    paymentId: row.payment_id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    shopId: row.shop_id,
    errorMessage: row.error_message,
    printedAt: row.printed_at ? new Date(row.printed_at).getTime() : undefined,
    priority: row.priority,
    paperSize: row.paper_size
  };
}


// 1. Live RTDB / Supabase Realtime Print Job Listener
function startLiveListener() {
  if (supabase) {
    console.log(`Agent: Listening for pending print jobs on Supabase Realtime for Shop ID: ${SHOP_ID}...`);
    
    if (realtimeChannel) {
      realtimeChannel.unsubscribe();
    }

    realtimeChannel = supabase
      .channel('pending_jobs_channel')
      .on('postgres_changes', {
        event: '*', // Listen to INSERT, UPDATE
        schema: 'public',
        table: 'print_queue',
        filter: `shop_id=eq.${SHOP_ID}`
      }, (payload) => {
        const row = payload.new;
        if (row && row.status === 'pending') {
          const mappedJob = mapSupabaseJob(row);
          enqueueJob(row.id, mappedJob);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Agent: Successfully subscribed to Supabase Realtime Postgres Changes.');
        }
      });
      
    return;
  }

  if (db) {
    try {
      db.ref('print_queue').off();
    } catch (e) {
      console.warn('Agent: Error clearing firebase listeners:', e.message);
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
}

async function updatePrintersStatusHeartbeat() {
  try {
    let printers = localConfig.printers || {};
    let statusChanged = false;

    for (const [id, printer] of Object.entries(printers)) {
      let currentStatus = 'online';
      
      if (process.env.MOCK_PRINT_TO_FILE !== 'true') {
        try {
          const osPrinters = await ptp.getPrinters();
          const match = osPrinters.find(p => p.name === printer.name);
          if (!match) {
            currentStatus = 'offline';
          }
        } catch (e) {
          // silent fallback
        }
      } else {
        const rand = Math.random();
        if (rand < 0.05) currentStatus = 'paper-out';
        else if (rand < 0.10) currentStatus = 'ink-low';
        else currentStatus = 'online';
      }

      if (printer.status !== currentStatus) {
        printer.status = currentStatus;
        statusChanged = true;
      }
    }

    if (statusChanged) {
      localConfig.printers = printers;
      saveLocalConfig();
      
      if (db) {
        await db.ref(`settings/${SHOP_ID}/printers`).set(printers);
      } else {
        const headers = {};
        if (sessionToken) {
          headers['Authorization'] = `Bearer ${sessionToken}`;
        }
        await axios.post(`${BACKEND_API_URL}/api/settings`, { shopId: SHOP_ID, printers }, { headers });
      }
      console.log('Agent: Updated printer health statuses to database.');
    }
  } catch (err) {
    // suppress logs
  }
}

// Check and update printers status every 30 seconds
setInterval(updatePrintersStatusHeartbeat, 30000);
// Trigger initial check immediately
setTimeout(updatePrintersStatusHeartbeat, 2000);

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
    await syncJobStatusUpdate(jobId, statusVal, extra);
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
      const mockPrintsDir = path.join(BASE_DIR, 'mock_prints');
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

// POST: Forward login to backend; update local Shop ID context on success
app.post('/api/login', async (req, res) => {
  const { shopId, password } = req.body;
  if (!shopId || !password) {
    return res.status(400).json({ error: 'Shop ID and password are required.' });
  }

  try {
    // Confirm profile exists in the backend before attempting login
    let profileExists = false;
    try {
      const profileResp = await axios.get(`${BACKEND_API_URL}/api/v1/profile/${shopId}`);
      profileExists = profileResp.data.passwordSet;
    } catch (e) { /* quiet fallback */ }

    if (!profileExists) {
      return res.status(400).json({ error: 'Shop ID is not registered. Please register first.' });
    }

    const loginResp = await axios.post(`${BACKEND_API_URL}/api/v1/auth/login`, { shopId, password });
    if (!loginResp.data.success) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    // Switch local agent context to the new shop
    localConfig.shopId = shopId;
    localConfig.sessionToken = loginResp.data.token || '';
    saveLocalConfig();
    SHOP_ID = shopId;
    sessionToken = loginResp.data.token || '';

    // Reset print state for the new shop
    jobQueue = [];
    isPrinting = false;

    // Restart live listener (Firebase or Supabase)
    startLiveListener();

    console.log(`Agent: Logged in → Shop ID: ${SHOP_ID}`);
    res.json({
      success: true,
      token: loginResp.data.token,
      shopId,
      firstLogin: loginResp.data.firstLogin || false
    });
  } catch (err) {
    console.error('Agent login error:', err.message);
    const status = err.response?.status || 500;
    const errMsg = err.response?.data?.error || err.message;
    res.status(status).json({ error: errMsg });
  }
});

// POST: Register a new shop — creates Supabase Auth user + profile
app.post('/api/register', async (req, res) => {
  const { shopName, email, password } = req.body;
  if (!shopName || !email || !password) {
    return res.status(400).json({ error: 'Shop name, email, and password are required.' });
  }

  try {
    const registerResp = await axios.post(`${BACKEND_API_URL}/api/v1/auth/register`, { shopName, email, password });
    if (!registerResp.data.success) {
      return res.status(400).json({ error: registerResp.data.error || 'Registration failed.' });
    }

    const { shopId, token } = registerResp.data;

    // Set local agent context to the newly registered shop
    localConfig.shopId = shopId;
    localConfig.sessionToken = token || '';
    saveLocalConfig();
    SHOP_ID = shopId;
    sessionToken = token || '';

    // Reset print state
    jobQueue = [];
    isPrinting = false;

    // Start live listener for the new shop
    startLiveListener();

    console.log(`Agent: Registered new shop → Shop ID: ${SHOP_ID}`);
    res.json(registerResp.data);
  } catch (err) {
    console.error('Agent register error:', err.message);
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
    if (supabase) {
      const { data: settingsData } = await supabase
        .from('settings')
        .select('*')
        .eq('shop_id', SHOP_ID)
        .maybeSingle();

      if (settingsData) {
        bwPrice = settingsData.bw_price ?? 2;
        colorPrice = settingsData.color_price ?? 10;
        maxPagesPerBatch = settingsData.max_pages_per_batch ?? 80;
        cooldownMin = settingsData.cooldown_min ?? 5;
        printers = settingsData.printers ?? {};
      }

      const { data: profileData } = await supabase
        .from('profiles')
        .select('upi_id')
        .eq('shop_id', SHOP_ID)
        .maybeSingle();

      if (profileData) {
        upiId = profileData.upi_id ?? '';
      }

      const { data: queueData } = await supabase
        .from('print_queue')
        .select('*')
        .eq('shop_id', SHOP_ID);

      const dbLogs = [];
      if (queueData) {
        queueData.forEach((row) => {
          const job = {
            id: row.id,
            shopId: row.shop_id,
            fileUrl: row.file_url,
            printType: row.print_type,
            totalPages: Number(row.total_pages),
            copies: Number(row.copies),
            tokenNumber: row.token_number,
            status: row.status,
            paid: row.paid,
            cost: Number(row.cost),
            paymentId: row.payment_id,
            createdAt: new Date(row.created_at).getTime(),
            priority: row.priority,
            errorMessage: row.error_message
          };

          if (job.status === 'completed' && job.cost) {
            revenue += job.cost;
            ordersCount++;
          }
          dbLogs.push({
            id: job.id,
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
    } else if (db) {
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

app.get('/api/analytics', async (req, res) => {
  try {
    let completedJobs = [];
    
    if (supabase) {
      const { data, error } = await supabase
        .from('print_queue')
        .select('*')
        .eq('shop_id', SHOP_ID)
        .eq('status', 'completed');
      if (!error && data) {
        completedJobs = data.map(row => ({
          printType: row.print_type,
          totalPages: Number(row.total_pages),
          copies: Number(row.copies),
          cost: Number(row.cost),
          createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
          paperSize: row.paper_size
        }));
      }
    } else if (db) {
      const snap = await db.ref('print_queue').once('value');
      const val = snap.val();
      if (val) {
        Object.values(val).forEach(job => {
          if (job.shopId === SHOP_ID && job.status === 'completed') {
            completedJobs.push({
              printType: job.printType,
              totalPages: job.totalPages || 1,
              copies: job.copies || 1,
              cost: job.cost || 0,
              createdAt: job.createdAt || Date.now(),
              paperSize: job.paperSize || 'A4'
            });
          }
        });
      }
    } else {
      printLogs.forEach(log => {
        if (log.status === 'completed') {
          completedJobs.push({
            printType: log.printType,
            totalPages: log.sheets || 1,
            copies: log.copies || 1,
            cost: log.cost || 0,
            createdAt: Date.now(),
            paperSize: 'A4'
          });
        }
      });
    }

    let totalRevenue = 0;
    let totalSheets = 0;
    let bwCount = 0;
    let colorCount = 0;
    let paperSizeCounts = {};
    let hourlyDistribution = Array(24).fill(0);

    completedJobs.forEach(job => {
      totalRevenue += job.cost;
      totalSheets += (job.totalPages * job.copies);
      if (job.printType === 'bw') bwCount++;
      else if (job.printType === 'color') colorCount++;
      
      const pSize = job.paperSize || 'A4';
      paperSizeCounts[pSize] = (paperSizeCounts[pSize] || 0) + 1;
      
      const hour = new Date(job.createdAt).getHours();
      hourlyDistribution[hour]++;
    });

    const avgSheets = completedJobs.length > 0 ? (totalSheets / completedJobs.length).toFixed(1) : 0;

    res.json({
      revenue: totalRevenue,
      orders: completedJobs.length,
      averageSheets: Number(avgSheets),
      ratios: {
        bw: bwCount,
        color: colorCount
      },
      paperSizes: paperSizeCounts,
      hourlyDistribution: hourlyDistribution
    });
  } catch (err) {
    console.error('Agent: Failed to generate analytics data:', err.message);
    res.status(500).json({ error: err.message });
  }
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
      
      const headers = {};
      const authHeader = req.headers.authorization;
      if (authHeader) {
        headers['Authorization'] = authHeader;
      } else if (sessionToken) {
        headers['Authorization'] = `Bearer ${sessionToken}`;
      }

      await axios.post(`${BACKEND_API_URL}/api/settings`, payload, { headers });
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
  try {
    await syncJobPriorityUpdate(id, !!priority);
    res.json({ success: true, message: 'Priority updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update priority: ' + err.message });
  }
});

// POST: Proxy Set print job status (Allows shopkeeper to confirm direct UPI payments)
app.post('/api/jobs/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, paid } = req.body;
  try {
    await syncJobStatusUpdate(id, status, paid !== undefined ? { paid } : {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status: ' + err.message });
  }
});

// Start dashboard server on Port 3000
const DASHBOARD_PORT = 3000;
app.listen(DASHBOARD_PORT, '127.0.0.1', () => {
  console.log(`================================================================`);
  console.log(`👨‍💼 SHOPKEEPER DASHBOARD IS READY!`);
  console.log(`Open dashboard in your browser: http://localhost:${DASHBOARD_PORT}`);
  console.log(`================================================================`);
});

// Simulated Loop Demo Mode
function runSimulatedDemoLoop() {
  console.log('Agent: Starting local demo mode...');
}
