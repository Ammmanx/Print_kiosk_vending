import express, { Request, Response } from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import Razorpay from 'razorpay';
import nodemailer from 'nodemailer';
import axios from 'axios';
import * as qrcode from 'qrcode';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5002;

app.use(cors());

// Prepare upload directory and serve statically
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper: Magic-Byte Binary Header Validation for PDFs and Images (PNG, JPEG, WEBP)
function isValidMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;

  // PDF Magic Bytes: %PDF- (0x25 0x50 0x44 0x46)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return true;
  }

  // PNG Magic Bytes: 0x89 0x50 0x4E 0x47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return true;
  }

  // JPEG / JPG Magic Bytes: 0xFF 0xD8 0xFF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return true;
  }

  // WEBP Magic Bytes: "RIFF" at offset 0 and "WEBP" at offset 8
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return true;
  }

  return false;
}

// Background Upload Storage Cleanup Worker (Deletes uploads older than 30 minutes)
setInterval(() => {
  try {
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      files.forEach((file) => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          console.log(`Backend Cleanup: Automatically purged expired customer upload: ${file}`);
        }
      });
    }
  } catch (err: any) {
    console.error('Backend Storage Cleanup Error:', err.message);
  }
}, 5 * 60 * 1000);

app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}));

// Keep track of client checkouts for cooldown limits per shop
const clientCheckoutTimes = new Map<string, number>();

// Middleware to capture raw body (needed for Razorpay webhook verification)
app.use(
  express.json({
    limit: '60mb',
    verify: (req: any, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

// Initialize Razorpay Client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
});

// Initialize Firebase Admin
const firebaseDbUrl = process.env.FIREBASE_DATABASE_URL;
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';

let db: admin.database.Database | undefined;

try {
  const absoluteServiceAccountPath = path.resolve(serviceAccountPath);
  if (fs.existsSync(absoluteServiceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(absoluteServiceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: firebaseDbUrl,
    });
    console.log('Firebase Admin initialized with service account.');
    db = admin.database();
  } else {
    console.warn(`Firebase service account file not found at: ${absoluteServiceAccountPath}. Running in local mock DB fallback mode.`);
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin. Running in local mock DB fallback mode.', error);
}

// Zod Validation Schema for Checkout API
const checkoutSchema = z.object({
  fileUrl: z.string().url('Invalid file URL'),
  printType: z.enum(['color', 'bw']),
  totalPages: z.number().int().positive('Total pages must be a positive integer'),
  copies: z.number().int().positive('Copies must be a positive integer').default(1),
  clientId: z.string().optional(),
  customerContact: z.string().optional(),
  captchaToken: z.string().optional(),
  shopId: z.string().default('default_shop'),
  payment: z.object({
    orderId: z.string().optional(),
    paymentId: z.string().optional(),
    signature: z.string().optional(),
    method: z.string().optional()
  }).optional(),
  status: z.enum(['pending', 'pending_payment']).optional(),
  paperSize: z.string().optional()
});

// Local mock database fallback store
interface MockJob {
  id: string;
  fileUrl: string;
  printType: 'color' | 'bw';
  totalPages: number;
  copies: number;
  tokenNumber: string;
  status: 'pending' | 'pending_payment' | 'printing' | 'completed' | 'failed';
  paid: boolean;
  cost: number;
  paymentId: string;
  createdAt: number;
  shopId: string;
  errorMessage?: string;
  printedAt?: number;
  priority?: boolean;
  paperSize?: string;
}

interface KioskPrinter {
  id: string;
  name: string;
  maxPages: number;
  cooldownMin: number;
  colorMode: 'bw' | 'color' | 'both';
  paperSize?: string;
  scale?: string;
}

interface ShopSettings {
  bwPrice: number | null;
  colorPrice: number | null;
  maxPagesPerBatch: number;
  cooldownMin: number;
  printers?: Record<string, KioskPrinter>;
  upiId?: string;
}

const mockSettingsStore: Record<string, ShopSettings> = {};

// ===== AUTH & PROFILE STRUCTURES =====
// In-memory session token map: token -> shopId
const sessionTokens = new Map<string, string>();

interface ShopProfile {
  shopName: string;
  passwordHash: string;
  upiId: string;
  qrCode?: string;
  qrCodeUrl?: string;
}
const shopProfiles: Record<string, ShopProfile> = {};

function getProfile(shopId: string): ShopProfile {
  if (!shopProfiles[shopId]) {
    shopProfiles[shopId] = { shopName: shopId, passwordHash: '', upiId: '', qrCode: '', qrCodeUrl: '' };
  }
  return shopProfiles[shopId];
}

async function getOrCreateQRCode(shopId: string): Promise<string> {
  const currentPublicUrl = process.env.PUBLIC_FRONTEND_URL
    ? `${process.env.PUBLIC_FRONTEND_URL}/?shop=${shopId}`
    : `http://localhost:8080/?shop=${shopId}`;

  let existingQr = '';
  let existingQrUrl = '';
  try {
    if (db) {
      const snap = await db.ref(`profiles/${shopId}`).once('value');
      const p = snap.val();
      if (p) {
        existingQr = p.qrCode || '';
        existingQrUrl = p.qrCodeUrl || '';
      }
    } else {
      const p = getProfile(shopId);
      existingQr = p.qrCode || '';
      existingQrUrl = p.qrCodeUrl || '';
    }
  } catch (err) {
    // quiet fallback
  }

  if (existingQr && existingQrUrl === currentPublicUrl) {
    return existingQr;
  }

  try {
    const qrCodeDataUrl = await (qrcode as any).toDataURL(currentPublicUrl, {
      width: 400,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' }
    });

    if (db) {
      await db.ref(`profiles/${shopId}`).update({
        qrCode: qrCodeDataUrl,
        qrCodeUrl: currentPublicUrl
      });
    } else {
      const p = getProfile(shopId);
      p.qrCode = qrCodeDataUrl;
      p.qrCodeUrl = currentPublicUrl;
    }

    console.log(`Backend: Generated and stored permanent QR code for shop ${shopId} pointing to: ${currentPublicUrl}`);
    return qrCodeDataUrl;
  } catch (err: any) {
    console.error(`Backend: Failed to generate/store QR code for ${shopId}:`, err.message);
    return existingQr || '';
  }
}

// Auth middleware
function requireAuth(req: Request, res: Response, next: any): void {
  const token = req.headers['x-auth-token'] as string;
  if (!token || !sessionTokens.has(token)) {
    res.status(401).json({ error: 'Unauthorized. Please log in.' });
    return;
  }
  next();
}

function getMockSettings(shopId: string): ShopSettings {
  if (!mockSettingsStore[shopId]) {
    mockSettingsStore[shopId] = {
      bwPrice: null,
      colorPrice: null,
      maxPagesPerBatch: 80,
      cooldownMin: 5,
      printers: {},
      upiId: ''
    };
  }
  return mockSettingsStore[shopId];
}

const mockJobsQueue: MockJob[] = [];

// reCAPTCHA v3 verification middleware
async function verifyCaptcha(req: Request, res: Response, next: any) {
  const token = req.body.captchaToken;
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  if (!secretKey || secretKey === 'captcha_secret_placeholder') {
    console.log('CAPTCHA Check: Bypassed verification (RECAPTCHA_SECRET_KEY unconfigured).');
    return next();
  }

  if (!token) {
    res.status(400).json({ error: 'Bot protection check failed: Captcha token missing.' });
    return;
  }

  try {
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${token}`;
    const response = await axios.post(verifyUrl);
    if (response.data.success && response.data.score >= 0.5) {
      next();
    } else {
      console.warn('Google reCAPTCHA validation failed. Score:', response.data.score);
      res.status(400).json({ error: 'Bot protection verification rejected. Please refresh and try again.' });
    }
  } catch (err: any) {
    console.error('reCAPTCHA system connection error:', err.message);
    res.status(500).json({ error: 'CAPTCHA authentication service unavailable.' });
  }
}

// Mail notifier logic
async function sendNotification(customerEmail: string, token: string, etaText: string, amount: number) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'insta-print@kiosk.com';

  const message = `Your print job is scheduled!\n\nToken: ${token}\nEstimated Time: ${etaText}\nAmount Paid: ₹${amount.toFixed(2)}\n\nPresent this Token number at the kiosk counter to collect your prints.`;
  
  // Local notification fallback logs
  const logLine = `[Notification] [${new Date().toISOString()}] Target: ${customerEmail} | Token: ${token} | ETA: ${etaText} | Total: ₹${amount}\n`;
  fs.appendFileSync(path.join(__dirname, '..', 'notifications.log'), logLine);
  console.log(logLine.trim());

  if (host && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
      });

      await transporter.sendMail({
        from,
        to: customerEmail,
        subject: `InstaPrint Kiosk - Order Confirmed (${token})`,
        text: message
      });
      console.log(`Notification sent to ${customerEmail}`);
    } catch (err: any) {
      console.error('Failed to dispatch notification email:', err.message);
    }
  }
}

// Push Alerts to Shopkeeper FCM Devices
async function notifyShopkeeper(token: string, printType: string, pages: number, shopId: string) {
  if (db) {
    try {
      const payload = {
        notification: {
          title: '🆕 New Kiosk Print Job',
          body: `Token: ${token} | Type: ${printType.toUpperCase()} | Sheets: ${pages}`
        },
        topic: `shop_${shopId}_alerts`
      };
      await admin.messaging().send(payload);
      console.log(`FCM Alert broadcast to shop topic: shop_${shopId}_alerts`);
    } catch (err: any) {
      // FCM unconfigured
    }
  }
}

// Helper to calculate dynamic queue wait time per shop
async function calculateDynamicEta(totalPages: number, copies: number, shopId: string): Promise<string> {
  let pendingPagesCount = 0;
  try {
    if (db) {
      const snap = await db.ref('print_queue').once('value');
      const val = snap.val();
      if (val) {
        Object.values(val).forEach((job: any) => {
          if (job.shopId === shopId && (job.status === 'pending' || job.status === 'printing')) {
            pendingPagesCount += (job.totalPages * job.copies);
          }
        });
      }
    } else {
      mockJobsQueue.forEach((job) => {
        if (job.shopId === shopId && (job.status === 'pending' || job.status === 'printing')) {
          pendingPagesCount += (job.totalPages * job.copies);
        }
      });
    }
  } catch (err) {
    // Fail silently
  }

  const basePrepSeconds = 30;
  const printSecondsPerPage = 5;
  const totalSeconds = basePrepSeconds + (pendingPagesCount + (totalPages * copies)) * printSecondsPerPage;
  const etaMinutes = Math.ceil(totalSeconds / 60);
  return `${etaMinutes} min`;
}

// 1. Get Settings (Rates, Max Batch size, cooldown) - supports shopId query
app.get('/api/settings', async (req: Request, res: Response): Promise<void> => {
  const shopId = (req.query.shopId as string) || 'default_shop';
  try {
    let bwPrice = null;
    let colorPrice = null;
    let maxPagesPerBatch = 80;
    let cooldownMin = 5;
    let printers = {};
    let upiId = '';

    if (db) {
      const settingsSnap = await db.ref(`settings/${shopId}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        bwPrice = settings.bwPrice ?? null;
        colorPrice = settings.colorPrice ?? null;
        maxPagesPerBatch = settings.maxPagesPerBatch ?? 80;
        cooldownMin = settings.cooldownMin ?? 5;
        printers = settings.printers ?? {};
        upiId = settings.upiId ?? '';
      }
    } else {
      const settings = getMockSettings(shopId);
      bwPrice = settings.bwPrice;
      colorPrice = settings.colorPrice;
      maxPagesPerBatch = settings.maxPagesPerBatch;
      cooldownMin = settings.cooldownMin;
      printers = settings.printers || {};
      upiId = settings.upiId || '';
    }
    const recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY || 'captcha_site_placeholder';
    res.status(200).json({ bwPrice, colorPrice, maxPagesPerBatch, cooldownMin, printers, upiId, recaptchaSiteKey });
  } catch (error: any) {
    res.status(200).json({ bwPrice: null, colorPrice: null, maxPagesPerBatch: 80, cooldownMin: 5, printers: {}, upiId: '', recaptchaSiteKey: 'captcha_site_placeholder' });
  }
});

// v1 Settings Endpoint - matches dashboard settings
app.get('/api/v1/settings/:shopId', async (req: Request, res: Response) => {
  const { shopId } = req.params;
  try {
    let bwPrice = null;
    let colorPrice = null;
    let maxPagesPerBatch = 80;
    let cooldownMin = 5;
    let printers = {};
    let upiId = '';

    if (db) {
      const settingsSnap = await db.ref(`settings/${shopId}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        bwPrice = settings.bwPrice ?? null;
        colorPrice = settings.colorPrice ?? null;
        maxPagesPerBatch = settings.maxPagesPerBatch ?? 80;
        cooldownMin = settings.cooldownMin ?? 5;
        printers = settings.printers ?? {};
        upiId = settings.upiId ?? '';
      }
    } else {
      const settings = getMockSettings(shopId);
      bwPrice = settings.bwPrice;
      colorPrice = settings.colorPrice;
      maxPagesPerBatch = settings.maxPagesPerBatch;
      cooldownMin = settings.cooldownMin;
      printers = settings.printers || {};
      upiId = settings.upiId || '';
    }
    const recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY || 'captcha_site_placeholder';
    res.status(200).json({ bwPrice, colorPrice, maxPagesPerBatch, cooldownMin, printers, upiId, recaptchaSiteKey });
  } catch (error: any) {
    res.status(200).json({ bwPrice: null, colorPrice: null, maxPagesPerBatch: 80, cooldownMin: 5, printers: {}, upiId: '', recaptchaSiteKey: 'captcha_site_placeholder' });
  }
});

// 2. Create Razorpay Payment Order (Pricing computed dynamically from DB, Captcha protected)
app.post('/api/payment/order', verifyCaptcha, async (req: Request, res: Response): Promise<void> => {
  try {
    const { printType, totalPages, copies, clientId, shopId = 'default_shop' } = req.body;
    
    if (!printType || !totalPages || !copies) {
      res.status(400).json({ error: 'Missing parameters: printType, totalPages, and copies are required.' });
      return;
    }

    // Load active settings per shop
    let rate: number | null = null;
    let maxPagesPerBatch = 80;
    let cooldownMin = 5;

    if (db) {
      const settingsSnap = await db.ref(`settings/${shopId}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        rate = printType === 'bw' ? (settings.bwPrice ?? null) : (settings.colorPrice ?? null);
        maxPagesPerBatch = settings.maxPagesPerBatch ?? 80;
        cooldownMin = settings.cooldownMin ?? 5;
      }
    } else {
      const settings = getMockSettings(shopId);
      rate = printType === 'bw' ? settings.bwPrice : settings.colorPrice;
      maxPagesPerBatch = settings.maxPagesPerBatch;
      cooldownMin = settings.cooldownMin;
    }

    if (rate === null || rate === undefined) {
      res.status(400).json({ error: 'Kiosk printing rates are not configured by operator yet.' });
      return;
    }

    // Validation page count limits
    if (totalPages > maxPagesPerBatch) {
      res.status(400).json({ error: `Order blocked: Maximum pages restricted to ${maxPagesPerBatch} pages.` });
      return;
    }

    // Cooldown Validation bypassed (removed per user request)

    const sheets = parseInt(totalPages);
    const amountInRupees = sheets * rate * parseInt(copies);
    const amountInPaise = amountInRupees * 100;

    const options = {
      amount: Math.round(amountInPaise),
      currency: 'INR',
      receipt: `receipt_kiosk_${Date.now()}`
    };

    if (process.env.RAZORPAY_KEY_ID === 'rzp_test_placeholder' || !process.env.RAZORPAY_KEY_ID) {
      res.status(200).json({
        mockOrder: true,
        orderId: 'mock_order_' + Date.now(),
        amount: options.amount,
        currency: 'INR',
        keyId: 'rzp_test_placeholder'
      });
      return;
    }

    const order = await razorpay.orders.create(options);
    res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error: any) {
    console.error('Failed to create Razorpay order:', error);
    res.status(500).json({ error: 'Order Creation Failed', message: error.message });
  }
});

// v1 Tokenized Payment checkout
app.post('/api/v1/payments', verifyCaptcha, async (req: Request, res: Response) => {
  try {
    const { printType, totalPages, copies, clientId, shopId = 'default_shop' } = req.body;
    
    if (!printType || !totalPages || !copies) {
      res.status(400).json({ error: 'Missing parameters: printType, totalPages, and copies are required.' });
      return;
    }

    let rate: number | null = null;
    let maxPagesPerBatch = 80;
    let cooldownMin = 5;

    if (db) {
      const settingsSnap = await db.ref(`settings/${shopId}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        rate = printType === 'bw' ? (settings.bwPrice ?? null) : (settings.colorPrice ?? null);
        maxPagesPerBatch = settings.maxPagesPerBatch ?? 80;
        cooldownMin = settings.cooldownMin ?? 5;
      }
    } else {
      const settings = getMockSettings(shopId);
      rate = printType === 'bw' ? settings.bwPrice : settings.colorPrice;
      maxPagesPerBatch = settings.maxPagesPerBatch;
      cooldownMin = settings.cooldownMin;
    }

    if (rate === null || rate === undefined) {
      res.status(400).json({ error: 'Kiosk printing rates are not configured by operator yet.' });
      return;
    }

    if (totalPages > maxPagesPerBatch) {
      res.status(400).json({ error: `Order blocked: Maximum pages restricted to ${maxPagesPerBatch} pages.` });
      return;
    }

    // Cooldown Validation bypassed (removed per user request)

    const sheets = parseInt(totalPages);
    const amountInRupees = sheets * rate * parseInt(copies);
    const amountInPaise = amountInRupees * 100;

    const options = {
      amount: Math.round(amountInPaise),
      currency: 'INR',
      receipt: `receipt_kiosk_${Date.now()}`
    };

    if (process.env.RAZORPAY_KEY_ID === 'rzp_test_placeholder' || !process.env.RAZORPAY_KEY_ID) {
      res.status(200).json({
        mockOrder: true,
        orderId: 'mock_order_' + Date.now(),
        amount: options.amount,
        currency: 'INR',
        keyId: 'rzp_test_placeholder'
      });
      return;
    }

    const order = await razorpay.orders.create(options);
    res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Payment Tokenization Failed', message: error.message });
  }
});

// 3. Checkout API Route (Verifies signature and queues job, supports DD-N tokens)
app.post('/api/checkout', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = checkoutSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Validation failed', details: parseResult.error.format() });
      return;
    }

    const { fileUrl, printType, totalPages, copies, payment, clientId, customerContact, shopId, paperSize } = parseResult.data;

    // Verify Payment Signature if payment object is supplied
    if (payment && payment.signature && payment.orderId && payment.paymentId && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_SECRET !== 'secret_placeholder') {
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      const hmac = crypto.createHmac('sha256', keySecret);
      hmac.update(payment.orderId + '|' + payment.paymentId);
      const generatedSignature = hmac.digest('hex');

      const isSignatureValid = crypto.timingSafeEqual(
        Buffer.from(payment.signature, 'utf8'),
        Buffer.from(generatedSignature, 'utf8')
      );

      if (!isSignatureValid) {
        res.status(400).json({ error: 'Payment verification failed. Invalid signature.' });
        return;
      }
    } else if (parseResult.data.status === 'pending' && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_SECRET !== 'secret_placeholder') {
      res.status(400).json({ error: 'Payment verification required. Unsigned paid transactions are not permitted.' });
      return;
    }

    // Cooldown verification
    let cooldownMin = 5;
    if (db) {
      const settingsSnap = await db.ref(`settings/${shopId}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        cooldownMin = settings.cooldownMin ?? 5;
      }
    } else {
      cooldownMin = getMockSettings(shopId).cooldownMin;
    }

    // Cooldown verification bypassed (removed per user request)

    // Calculate billing cost based on database rates to record in finance logs
    let rate: number | null = null;
    if (db) {
      const settingsSnap = await db.ref(`settings/${shopId}`).once('value');
      const settings = settingsSnap.val();
      if (settings) {
        rate = printType === 'bw' ? (settings.bwPrice ?? null) : (settings.colorPrice ?? null);
      }
    } else {
      rate = printType === 'bw' ? getMockSettings(shopId).bwPrice : getMockSettings(shopId).colorPrice;
    }

    if (rate === null) {
      res.status(400).json({ error: 'Kiosk printing rates are not configured by operator yet.' });
      return;
    }
    const billingCost = totalPages * rate * copies;
    const requestedStatus = parseResult.data.status || 'pending_payment';
    const isPaid = requestedStatus === 'pending' && Boolean(payment?.signature);

    // Generate static ETA
    const etaText = await calculateDynamicEta(totalPages, copies, shopId);

    if (!db) {
      // Offline Local Mock DB Fallback: Generate daily DD-N token
      const todayStr = String(new Date().getDate()).padStart(2, '0');
      const todayJobs = mockJobsQueue.filter(j => j.shopId === shopId && j.tokenNumber.startsWith(`${todayStr}-`));
      const mockTokenVal = todayJobs.length + 1;
      const tokenNumber = `${todayStr}-${mockTokenVal}`;
      const jobId = 'mock_job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
      
      const mockJob: MockJob = {
        id: jobId,
        fileUrl,
        printType,
        totalPages,
        copies,
        tokenNumber,
        status: requestedStatus,
        paid: isPaid,
        cost: billingCost,
        paymentId: payment?.paymentId || (isPaid ? 'development_mock' : 'direct_upi'),
        createdAt: Date.now(),
        shopId,
        paperSize: paperSize || 'A4'
      };
      
      mockJobsQueue.push(mockJob);
      console.log(`Local DB (${shopId}): Enqueued print job ${tokenNumber} (${jobId}) (Paid: ${isPaid}, Status: ${requestedStatus})`);

      // Dispatch notification
      if (customerContact) {
        await sendNotification(customerContact, tokenNumber, etaText, billingCost);
      }

      res.status(200).json({
        success: true,
        message: 'Checkout successful (MOCK DATABASE)',
        tokenNumber,
        jobId,
        eta: etaText
      });
      return;
    }

    // Get today's date string
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStrStr = `${year}-${month}-${day}`;

    // Database transaction to securely increment a daily counter per shop
    const counterRef = db.ref(`counters/${shopId}/${todayStrStr}`);
    const transactionResult = await counterRef.transaction((currentValue: number | null) => {
      return (currentValue || 0) + 1;
    });

    if (!transactionResult.committed) {
      res.status(500).json({ error: 'Failed to generate token number. Transaction aborted.' });
      return;
    }

    const currentCount = transactionResult.snapshot.val() as number;
    const dayStr = String(today.getDate()).padStart(2, '0');
    const tokenNumber = `${dayStr}-${currentCount}`;

    // Inject job into database with status pending (as payment is already complete)
    const queueRef = db.ref('print_queue');
    const newJobRef = queueRef.push();
    const jobKey = newJobRef.key;
    const jobData = {
      id: jobKey,
      fileUrl,
      printType,
      totalPages,
      copies,
      tokenNumber,
      status: requestedStatus,
      paid: isPaid,
      cost: billingCost,
      paymentId: payment?.paymentId || (isPaid ? 'development_mock' : 'direct_upi'),
      createdAt: admin.database.ServerValue.TIMESTAMP,
      shopId,
      paperSize: paperSize || 'A4'
    };

    await newJobRef.set(jobData);

    // Dispatch Notifications & FCM Alerts
    if (customerContact) {
      await sendNotification(customerContact, tokenNumber, etaText, billingCost);
    }
    await notifyShopkeeper(tokenNumber, printType, totalPages * copies, shopId);

    res.status(200).json({
      success: true,
      message: 'Print job paid and queued successfully',
      tokenNumber,
      jobId: newJobRef.key,
      eta: etaText
    });
  } catch (error: any) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// v1 Pickup route: fetch order status by tokenNumber
app.get('/api/v1/pickup/:token', async (req: Request, res: Response) => {
  const { token } = req.params;
  const shopId = (req.query.shopId as string) || 'default_shop';
  try {
    let targetJob: any = null;
    
    if (db) {
      const snap = await db.ref('print_queue').once('value');
      const val = snap.val();
      if (val) {
        targetJob = Object.values(val).find((j: any) => j.shopId === shopId && j.tokenNumber === token);
      }
    } else {
      targetJob = mockJobsQueue.find(j => j.shopId === shopId && j.tokenNumber === token);
    }

    if (targetJob) {
      const etaText = await calculateDynamicEta(targetJob.totalPages, targetJob.copies, shopId);
      res.status(200).json({
        token: targetJob.tokenNumber,
        status: targetJob.status,
        totalPages: targetJob.totalPages,
        copies: targetJob.copies,
        cost: targetJob.cost,
        eta: etaText
      });
    } else {
      res.status(404).json({ error: 'Print order token not found.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to look up pickup token: ' + err.message });
  }
});

// v1 PUT Orders status update
app.put('/api/v1/orders/:token/status', async (req: Request, res: Response) => {
  const { token } = req.params;
  const shopId = (req.query.shopId as string) || 'default_shop';
  const { status, errorMessage } = req.body;
  try {
    let targetJobKey: string | null = null;
    let targetJob: any = null;

    if (db) {
      const snap = await db.ref('print_queue').once('value');
      const val = snap.val();
      if (val) {
        const item = Object.entries(val).find(([_, j]: any) => j.shopId === shopId && j.tokenNumber === token);
        if (item) {
          targetJobKey = item[0];
          targetJob = item[1];
        }
      }
    } else {
      targetJob = mockJobsQueue.find(j => j.shopId === shopId && j.tokenNumber === token);
    }

    if (targetJob) {
      if (db && targetJobKey) {
        await db.ref(`print_queue/${targetJobKey}`).update({ status, errorMessage });
      } else {
        targetJob.status = status;
        if (errorMessage) targetJob.errorMessage = errorMessage;
      }
      res.status(200).json({ success: true, message: `Status updated to ${status}` });
    } else {
      res.status(404).json({ error: 'Print order token not found.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update order: ' + err.message });
  }
});

// 4. Webhook Route (Verifies HMAC signature, triggers post-payment fallback)
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
app.post('/webhook/payment', async (req: RawBodyRequest, res: Response): Promise<void> => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Webhook signature validation secret missing' });
    return;
  }

  const signature = req.headers['x-razorpay-signature'] as string;
  const rawBody = req.rawBody;

  if (!signature || !rawBody) {
    res.status(400).json({ error: 'Missing validation signature / body parameters.' });
    return;
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );

    if (!isValid) {
      res.status(400).json({ error: 'Signature mismatch' });
      return;
    }

    const event = req.body;
    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload.payment.entity;
      const jobId = paymentEntity.notes?.jobId;
      console.log(`Webhook fallback: verified payment captured for job ID ${jobId}`);

      if (db && jobId) {
        await db.ref(`print_queue/${jobId}`).update({
          status: 'pending',
          paid: true,
          paymentId: paymentEntity.id
        });
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error: any) {
    res.status(500).json({ error: 'Webhook processing error', message: error.message });
  }
});

app.post('/api/webhook/razorpay', async (req: RawBodyRequest, res: Response): Promise<void> => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Webhook configuration missing' });
    return;
  }
  const signature = req.headers['x-razorpay-signature'] as string;
  const rawBody = req.rawBody;

  if (!signature || !rawBody) {
    res.status(400).json({ error: 'Missing parameters.' });
    return;
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );

    if (!isValid) {
      res.status(400).json({ error: 'Signature verification mismatch' });
      return;
    }

    const event = req.body;
    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload.payment.entity;
      const jobId = paymentEntity.notes?.jobId;
      if (db && jobId) {
        await db.ref(`print_queue/${jobId}`).update({
          status: 'pending',
          paid: true,
          paymentId: paymentEntity.id
        });
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (error: any) {
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// POST: Save settings configurations (B&W, Color rate, Max batch size, cooldown) - supports shopId
app.post('/api/settings', async (req: Request, res: Response): Promise<void> => {
  try {
    const { shopId = 'default_shop', bwPrice, colorPrice, maxPagesPerBatch, cooldownMin, printers, upiId } = req.body;
    if (db) {
      const updatePayload: any = {
        bwPrice: parseFloat(bwPrice) || null,
        colorPrice: parseFloat(colorPrice) || null,
        maxPagesPerBatch: parseInt(maxPagesPerBatch) || 80,
        cooldownMin: parseInt(cooldownMin) || 5
      };
      if (printers !== undefined) {
        updatePayload.printers = printers;
      }
      if (upiId !== undefined) {
        updatePayload.upiId = upiId;
      }
      await db.ref(`settings/${shopId}`).update(updatePayload);
    }
    const settings = getMockSettings(shopId);
    settings.bwPrice = parseFloat(bwPrice) || null;
    settings.colorPrice = parseFloat(colorPrice) || null;
    settings.maxPagesPerBatch = parseInt(maxPagesPerBatch) || 80;
    settings.cooldownMin = parseInt(cooldownMin) || 5;
    if (printers !== undefined) {
      settings.printers = printers;
    }
    if (upiId !== undefined) {
      settings.upiId = upiId;
    }

    console.log(`Settings updated for shop ${shopId}:`, settings);
    res.status(200).json({ success: true, message: 'Settings saved successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save settings: ' + error.message });
  }
});

// GET: Fetch mock jobs filtered by shopId (for local agent polling)
app.get('/api/jobs', async (req: Request, res: Response): Promise<void> => {
  const shopId = (req.query.shopId as string) || 'default_shop';
  if (db) {
    try {
      const queueSnap = await db.ref('print_queue').once('value');
      const val = queueSnap.val();
      const filtered: Record<string, any> = {};
      if (val) {
        Object.entries(val).forEach(([key, job]: [string, any]) => {
          if (job.shopId === shopId) {
            filtered[key] = job;
          }
        });
      }
      res.status(200).json(filtered);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  } else {
    const jobsObj: Record<string, MockJob> = {};
    mockJobsQueue.forEach(j => {
      if (j.shopId === shopId) {
        jobsObj[j.id] = j;
      }
    });
    res.status(200).json(jobsObj);
  }
});

// POST: Update job status
app.post('/api/jobs/:id/status', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status, cost, printedAt, errorMessage, paid } = req.body;

  if (db) {
    try {
      const updatePayload: any = { status };
      if (cost !== undefined) updatePayload.cost = cost;
      if (printedAt !== undefined) updatePayload.printedAt = printedAt;
      if (errorMessage !== undefined) updatePayload.errorMessage = errorMessage;
      if (paid !== undefined) updatePayload.paid = paid;
      
      await db.ref(`print_queue/${id}`).update(updatePayload);
      res.status(200).json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  } else {
    const job = mockJobsQueue.find(j => j.id === id);
    if (job) {
      job.status = status;
      if (cost !== undefined) job.cost = cost;
      if (printedAt !== undefined) job.printedAt = printedAt;
      if (errorMessage !== undefined) job.errorMessage = errorMessage;
      if (paid !== undefined) job.paid = paid;
      console.log(`Local DB: Job ${id} status updated to: ${status} (Paid: ${job.paid})`);
      res.status(200).json({ success: true });
    } else {
      res.status(404).json({ error: 'Job not found' });
    }
  }
});

// POST: Set print job priority
app.post('/api/jobs/:id/priority', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { priority } = req.body;

  if (db) {
    try {
      await db.ref(`print_queue/${id}`).update({ priority: !!priority });
      res.status(200).json({ success: true, message: `Job ${id} priority updated to ${!!priority}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  } else {
    const job = mockJobsQueue.find(j => j.id === id);
    if (job) {
      job.priority = !!priority;
      console.log(`Local DB: Job ${id} priority updated to: ${!!priority}`);
      res.status(200).json({ success: true, message: `Job ${id} priority updated to ${!!priority}` });
    } else {
      res.status(404).json({ error: 'Job not found' });
    }
  }
});

// POST: Upload a file locally (Mock storage mode fallback)
app.post('/api/upload', (req: Request, res: Response): void => {
  try {
    const { filename, fileData } = req.body;
    if (!filename || !fileData) {
      res.status(400).json({ error: 'Missing filename or fileData payload.' });
      return;
    }
    const buffer = Buffer.from(fileData, 'base64');

    // Magic-Byte Binary Inspection (Ensures only genuine PDF/Image documents are saved)
    if (!isValidMagicBytes(buffer)) {
      console.warn(`Backend Security: Rejected uploaded file ${filename} due to invalid magic byte header.`);
      res.status(400).json({ 
        error: 'File upload rejected: Invalid or disguised file format. Only legitimate PDF documents and images (PNG, JPEG, WEBP) are allowed.' 
      });
      return;
    }

    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, buffer);

    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const fileUrl = `${protocol}://${host}/uploads/${filename}`;

    console.log(`Backend: Saved uploaded print document locally at: ${filePath}`);
    res.status(200).json({ success: true, fileUrl });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to write upload stream: ' + err.message });
  }
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ===== AUTH ROUTES =====

app.post('/api/v1/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { shopId = 'default_shop', password = '' } = req.body;
  try {
    let storedHash = '';
    if (db) {
      const snap = await db.ref(`profiles/${shopId}/passwordHash`).once('value');
      storedHash = snap.val() || '';
    } else {
      storedHash = getProfile(shopId).passwordHash;
    }

    if (!storedHash) {
      // First login: set this password
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await new Promise<string>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, derived) => {
          if (err) reject(err); else resolve(salt + ':' + derived.toString('hex'));
        });
      });
      if (db) await db.ref(`profiles/${shopId}/passwordHash`).set(hash);
      else getProfile(shopId).passwordHash = hash;

      // Generate permanent QR code for the new shopkeeper
      await getOrCreateQRCode(shopId);

      const sessionToken = crypto.randomBytes(32).toString('hex');
      sessionTokens.set(sessionToken, shopId);
      res.json({ success: true, firstLogin: true, token: sessionToken });
      return;
    }

    const [salt, key] = storedHash.split(':');
    const isValid = await new Promise<boolean>((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, derived) => {
        if (err) reject(err);
        else {
          try { resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived)); } catch { resolve(false); }
        }
      });
    });
    if (!isValid) { res.status(401).json({ error: 'Incorrect password.' }); return; }

    // Ensure QR code exists/is generated
    await getOrCreateQRCode(shopId);

    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessionTokens.set(sessionToken, shopId);
    res.json({ success: true, token: sessionToken });
  } catch (err: any) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.post('/api/v1/auth/change-password', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId = 'default_shop', oldPassword = '', newPassword } = req.body;
  if (!newPassword) { res.status(400).json({ error: 'New password is required.' }); return; }
  try {
    let storedHash = '';
    if (db) {
      const snap = await db.ref(`profiles/${shopId}/passwordHash`).once('value');
      storedHash = snap.val() || '';
    } else {
      storedHash = getProfile(shopId).passwordHash;
    }
    if (storedHash) {
      const [salt, key] = storedHash.split(':');
      const isValid = await new Promise<boolean>((resolve, reject) => {
        crypto.scrypt(oldPassword, salt, 64, (err, derived) => {
          if (err) reject(err);
          else { try { resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived)); } catch { resolve(false); } }
        });
      });
      if (!isValid) { res.status(401).json({ error: 'Old password is incorrect.' }); return; }
    }
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = await new Promise<string>((resolve, reject) => {
      crypto.scrypt(newPassword, newSalt, 64, (err, derived) => {
        if (err) reject(err); else resolve(newSalt + ':' + derived.toString('hex'));
      });
    });
    if (db) await db.ref(`profiles/${shopId}/passwordHash`).set(newHash);
    else getProfile(shopId).passwordHash = newHash;
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Password change failed: ' + err.message });
  }
});

// ===== PROFILE ROUTES =====

app.get('/api/v1/profile/:shopId', async (req: Request, res: Response): Promise<void> => {
  const { shopId } = req.params;
  try {
    let shopName = shopId; let upiId = ''; let passwordSet = false;
    let qrCode = '';
    if (db) {
      const snap = await db.ref(`profiles/${shopId}`).once('value');
      const p = snap.val();
      if (p) {
        shopName = p.shopName || shopId;
        upiId = p.upiId || '';
        passwordSet = !!p.passwordHash;
        qrCode = p.qrCode || '';
      }
    } else {
      const p = getProfile(shopId);
      shopName = p.shopName || shopId;
      upiId = p.upiId || '';
      passwordSet = !!p.passwordHash;
      qrCode = p.qrCode || '';
    }

    // Auto-generate QR code if it doesn't exist
    if (!qrCode) {
      qrCode = await getOrCreateQRCode(shopId);
    }

    const publicUrl = process.env.PUBLIC_FRONTEND_URL
      ? `${process.env.PUBLIC_FRONTEND_URL}/?shop=${shopId}`
      : `http://localhost:8080/?shop=${shopId}`;
    res.json({ shopId, shopName, upiId, passwordSet, storefrontUrl: publicUrl, qrCode });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/profile/:shopId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId } = req.params;
  const { shopName, upiId } = req.body;
  try {
    if (db) {
      const update: any = {};
      if (shopName !== undefined) update.shopName = shopName;
      if (upiId !== undefined) update.upiId = upiId;
      await db.ref(`profiles/${shopId}`).update(update);
    } else {
      const p = getProfile(shopId);
      if (shopName !== undefined) p.shopName = shopName;
      if (upiId !== undefined) p.upiId = upiId;
    }
    if (upiId !== undefined) {
      const settings = getMockSettings(shopId);
      settings.upiId = upiId;
      if (db) await db.ref(`settings/${shopId}/upiId`).set(upiId);
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ===== QR CODE ROUTE =====

app.get('/api/v1/qr/:shopId', async (req: Request, res: Response): Promise<void> => {
  const { shopId } = req.params;
  const publicUrl = process.env.PUBLIC_FRONTEND_URL
    ? `${process.env.PUBLIC_FRONTEND_URL}/?shop=${shopId}`
    : `http://localhost:8080/?shop=${shopId}`;
  try {
    const pngBuffer = await (qrcode as any).toBuffer(publicUrl, {
      type: 'png', width: 400, margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="qr_${shopId}.png"`);
    res.send(pngBuffer);
  } catch (err: any) {
    res.status(500).json({ error: 'QR generation failed: ' + err.message });
  }
});

// ===== DEDICATED PRINTER CRUD ROUTES =====

app.get('/api/v1/printers/:shopId', async (req: Request, res: Response): Promise<void> => {
  const { shopId } = req.params;
  try {
    let printers = {};
    if (db) {
      const snap = await db.ref(`settings/${shopId}/printers`).once('value');
      printers = snap.val() || {};
    } else {
      printers = getMockSettings(shopId).printers || {};
    }
    res.json({ printers });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/printers/:shopId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId } = req.params;
  const { name, colorMode = 'bw', maxPages = 80, cooldownMin = 5, paperSize = 'A4', scale = 'fit' } = req.body;
  if (!name) { res.status(400).json({ error: 'Printer name is required.' }); return; }
  const printerId = 'printer_' + Date.now();
  const printerObj = { id: printerId, name, colorMode, maxPages, cooldownMin, paperSize, scale };
  try {
    if (db) {
      await db.ref(`settings/${shopId}/printers/${printerId}`).set(printerObj);
    } else {
      const settings = getMockSettings(shopId);
      if (!settings.printers) settings.printers = {};
      (settings.printers as any)[printerId] = printerObj;
    }
    res.json({ success: true, printer: printerObj });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/printers/:shopId/:printerId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId, printerId } = req.params;
  const updates = req.body;
  try {
    if (db) {
      await db.ref(`settings/${shopId}/printers/${printerId}`).update(updates);
    } else {
      const settings = getMockSettings(shopId);
      if (settings.printers && (settings.printers as any)[printerId]) {
        Object.assign((settings.printers as any)[printerId], updates);
      }
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/printers/:shopId/:printerId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId, printerId } = req.params;
  try {
    if (db) {
      await db.ref(`settings/${shopId}/printers/${printerId}`).remove();
    } else {
      const settings = getMockSettings(shopId);
      if (settings.printers) delete (settings.printers as any)[printerId];
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Secure Cloud Backend running on http://localhost:${PORT}`);
});

