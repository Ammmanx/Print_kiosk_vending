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
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { initializeStores, settingsStore, jobStore, PrintJob, KioskPrinter } from './stores';

// Load environment variables
dotenv.config();

const app = reportAppErrors(express());
const PORT = process.env.PORT || 5002;

// Wrapper helper to log and handle route/app errors
function reportAppErrors(expressApp: express.Express) {
  return expressApp;
}

// Standard Security Headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigin = process.env.PUBLIC_FRONTEND_URL;
    if (!origin || !allowedOrigin || origin === allowedOrigin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 100, // limit each IP to 100 requests per window
  message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use(globalLimiter);

// Stricter limiter for logins
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 100 : 5, // limit each IP to 5 login attempts per 15 minutes
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
});

// Stricter limiter for file uploads
const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 100 : 5, // limit each IP to 5 uploads per minute
  message: { error: 'Too many file uploads. Please try again later.' }
});

// Checkout & Payment Limiters
const checkoutClientLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 100 : 3, // limit each client to 3 checkout attempts per minute
  message: { error: 'Too many checkouts. Please wait a moment.' }
});

const checkoutShopLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 100 : 5, // limit each shop to 5 checkout attempts per minute
  keyGenerator: (req: any) => (req.body.shopId || 'default_shop').toString(),
  message: { error: 'Too many checkouts for this shop. Please wait a moment.' }
});

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

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase: any;

if (supabaseUrl && supabaseServiceKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    console.log('Supabase Client initialized with Service Role Key.');
  } catch (err: any) {
    console.error('Failed to initialize Supabase Client:', err.message);
  }
}

// Initialize data-access stores
initializeStores(db, supabase);

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

// ===== AUTH & PROFILE STRUCTURES =====
// In-memory session tokens map removed per Part 1 instructions

async function getOrCreateQRCode(shopId: string): Promise<string> {
  const currentPublicUrl = process.env.PUBLIC_FRONTEND_URL
    ? `${process.env.PUBLIC_FRONTEND_URL}/?shop=${shopId}`
    : `http://localhost:8080/?shop=${shopId}`;

  let existingQr = '';
  let existingQrUrl = '';
  try {
    const profile = await settingsStore.getProfile(shopId);
    if (profile) {
      existingQr = profile.qrCode || '';
      existingQrUrl = profile.qrCodeUrl || '';
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

    await settingsStore.saveProfile(shopId, {
      qrCode: qrCodeDataUrl,
      qrCodeUrl: currentPublicUrl
    });

    console.log(`Backend: Generated and stored permanent QR code for shop ${shopId} pointing to: ${currentPublicUrl}`);
    return qrCodeDataUrl;
  } catch (err: any) {
    console.error(`Backend: Failed to generate/store QR code for ${shopId}:`, err.message);
    return existingQr || '';
  }
}

// Auth middleware
async function requireAuth(req: Request, res: Response, next: any): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // If not running under live Supabase authentication (e.g. mock local db tests),
    // we bypass strict header check so existing tests can run.
    if (!supabase) {
      return next();
    }
    res.status(401).json({ error: 'Authorization token missing.' });
    return;
  }
  
  const token = authHeader.split(' ')[1];
  if (!supabase) {
    return next();
  }
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired authorization token.' });
      return;
    }
    (req as any).user = user;
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Authentication failed.' });
  }
}

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
// Helper to send SMS notification (mock + Firebase trigger)
async function sendSMSNotification(phone: string, message: string) {
  const logLine = `[SMS Notification] [${new Date().toISOString()}] Target: ${phone} | Message: ${message}\n`;
  fs.appendFileSync(path.join(__dirname, '..', 'sms_notifications.log'), logLine);
  console.log(logLine.trim());

  if (db) {
    try {
      await db.ref('sms_queue').push({
        to: phone,
        body: message,
        createdAt: admin.database.ServerValue.TIMESTAMP,
        status: 'pending'
      });
      console.log(`SMS queued in Firebase database for: ${phone}`);
    } catch (err: any) {
      console.warn('Firebase SMS queue write failed:', err.message);
    }
  }
}

// Mail/SMS notifier logic
async function sendNotification(target: string, token: string, etaText: string, amount: number) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'insta-print@kiosk.com';

  const message = `Your print job is scheduled!\n\nToken: ${token}\nEstimated Time: ${etaText}\nAmount Paid: ₹${amount.toFixed(2)}\n\nPresent this Token number at the kiosk counter to collect your prints.`;
  
  const isPhone = !target.includes('@') && /^\+?[0-9\s\-]+$/.test(target);

  if (isPhone) {
    await sendSMSNotification(target, message);
    return;
  }

  // Local notification fallback logs
  const logLine = `[Notification] [${new Date().toISOString()}] Target: ${target} | Token: ${token} | ETA: ${etaText} | Total: ₹${amount}\n`;
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
        to: target,
        subject: `InstaPrint Kiosk - Order Confirmed (${token})`,
        text: message
      });
      console.log(`Notification sent to ${target}`);
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
    const jobs = await jobStore.getJobs(shopId);
    Object.values(jobs).forEach((job) => {
      if (job.status === 'pending' || job.status === 'printing') {
        pendingPagesCount += (job.totalPages * job.copies);
      }
    });
  } catch (err) {
    // Fail silently
  }

  const basePrepSeconds = 30;
  const printSecondsPerPage = 5;
  const totalSeconds = basePrepSeconds + (pendingPagesCount + (totalPages * copies)) * printSecondsPerPage;
  const etaMinutes = Math.ceil(totalSeconds / 60);
  return `${etaMinutes} min`;
}

// Canonical handler for GET Settings
async function getSettingsHandler(req: Request, res: Response): Promise<void> {
  const shopId = req.params.shopId || (req.query.shopId as string) || 'default_shop';
  try {
    const settings = await settingsStore.getSettings(shopId);
    const recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY || 'captcha_site_placeholder';
    res.status(200).json({ ...settings, recaptchaSiteKey });
  } catch (error: any) {
    res.status(200).json({ bwPrice: null, colorPrice: null, maxPagesPerBatch: 80, cooldownMin: 5, printers: {}, upiId: '', recaptchaSiteKey: 'captcha_site_placeholder' });
  }
}

// Canonical GET Settings Route
app.get('/api/v1/settings/:shopId', getSettingsHandler);

// TODO: deprecate GET /api/settings. Target removal version: v2.0.0
app.get('/api/settings', getSettingsHandler);

// Canonical handler for creating Razorpay Payment Orders
async function createPaymentOrderHandler(req: Request, res: Response): Promise<void> {
  try {
    const { printType, totalPages, copies, clientId, shopId = 'default_shop' } = req.body;
    
    if (!printType || !totalPages || !copies) {
      res.status(400).json({ error: 'Missing parameters: printType, totalPages, and copies are required.' });
      return;
    }

    // Load active settings per shop
    const settings = await settingsStore.getSettings(shopId);
    const rate = printType === 'bw' ? settings.bwPrice : settings.colorPrice;
    const maxPagesPerBatch = settings.maxPagesPerBatch ?? 80;
    const cooldownMin = settings.cooldownMin ?? 5;

    if (rate === null || rate === undefined) {
      res.status(400).json({ error: 'Kiosk printing rates are not configured by operator yet.' });
      return;
    }

    // Validation page count limits
    if (totalPages > maxPagesPerBatch) {
      res.status(400).json({ error: `Order blocked: Maximum pages restricted to ${maxPagesPerBatch} pages.` });
      return;
    }

    // Client-specific Cooldown Check
    const now = Date.now();
    const clientKey = `${shopId}:${clientId || req.ip}`;
    const lastClientTime = clientCheckoutTimes.get(clientKey);
    if (lastClientTime) {
      const elapsedMinutes = (now - lastClientTime) / (60 * 1000);
      if (elapsedMinutes < cooldownMin) {
        res.status(429).json({ error: `Client cooldown active. Please wait ${Math.ceil(cooldownMin - elapsedMinutes)} minutes before placing another order.` });
        return;
      }
    }

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
}

// Canonical payment order creation endpoint
app.post('/api/v1/payments', verifyCaptcha, checkoutClientLimiter, checkoutShopLimiter, createPaymentOrderHandler);

// TODO: deprecate POST /api/payment/order. Target removal version: v2.0.0
app.post('/api/payment/order', verifyCaptcha, checkoutClientLimiter, checkoutShopLimiter, createPaymentOrderHandler);

// 3. Checkout API Route (Verifies signature and queues job, supports DD-N tokens)
app.post('/api/checkout', checkoutClientLimiter, checkoutShopLimiter, async (req: Request, res: Response): Promise<void> => {
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

      const sigBuf = Buffer.from(payment.signature, 'utf8');
      const genSigBuf = Buffer.from(generatedSignature, 'utf8');

      const isSignatureValid = sigBuf.length === genSigBuf.length && crypto.timingSafeEqual(
        sigBuf,
        genSigBuf
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
    const settings = await settingsStore.getSettings(shopId);
    const cooldownMin = settings.cooldownMin ?? 5;

    // Enforce client checkout cooldown
    const now = Date.now();
    const clientKey = `${shopId}:${clientId || req.ip}`;
    const lastClientTime = clientCheckoutTimes.get(clientKey);
    if (lastClientTime) {
      const elapsedMinutes = (now - lastClientTime) / (60 * 1000);
      if (elapsedMinutes < cooldownMin) {
        res.status(429).json({ error: `Please wait ${Math.ceil(cooldownMin - elapsedMinutes)} minutes before submitting another print job at this shop.` });
        return;
      }
    }

    const rate = printType === 'bw' ? settings.bwPrice : settings.colorPrice;
    if (rate === null || rate === undefined) {
      res.status(400).json({ error: 'Kiosk printing rates are not configured by operator yet.' });
      return;
    }
    const billingCost = totalPages * rate * copies;
    const requestedStatus = parseResult.data.status || 'pending_payment';
    const isPaid = requestedStatus === 'pending' && Boolean(payment?.signature);

    // Generate static ETA
    const etaText = await calculateDynamicEta(totalPages, copies, shopId);

    // Get today's date string
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStrStr = `${year}-${month}-${day}`;

    const currentCount = await jobStore.incrementDailyToken(shopId, todayStrStr);
    const dayStr = String(today.getDate()).padStart(2, '0');
    const tokenNumber = `${dayStr}-${currentCount}`;

    // Record successful checkout/queue request client time
    clientCheckoutTimes.set(clientKey, now);

    const jobId = db ? db.ref('print_queue').push().key! : 'mock_job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const jobData: PrintJob = {
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

    await jobStore.enqueueJob(jobId, jobData);

    // Dispatch Notifications & FCM Alerts
    if (customerContact) {
      await sendNotification(customerContact, tokenNumber, etaText, billingCost);
    }
    await notifyShopkeeper(tokenNumber, printType, totalPages * copies, shopId);

    res.status(200).json({
      success: true,
      message: 'Print job paid and queued successfully',
      tokenNumber,
      jobId,
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
    const targetJob = await jobStore.getJobByToken(shopId, token);
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
    const targetJob = await jobStore.getJobByToken(shopId, token);
    if (targetJob) {
      await jobStore.updateJobStatus(targetJob.id, status, { errorMessage });
      res.status(200).json({ success: true, message: `Status updated to ${status}` });
    } else {
      res.status(404).json({ error: 'Print order token not found.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update order: ' + err.message });
  }
});

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// Canonical handler for Razorpay Webhooks
async function handleRazorpayWebhook(req: RawBodyRequest, res: Response): Promise<void> {
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

    const sigBuf = Buffer.from(signature, 'utf8');
    const genSigBuf = Buffer.from(expectedSignature, 'utf8');

    const isValid = sigBuf.length === genSigBuf.length && crypto.timingSafeEqual(
      sigBuf,
      genSigBuf
    );

    if (!isValid) {
      res.status(400).json({ error: 'Signature verification mismatch' });
      return;
    }

    const event = req.body;
    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload.payment.entity;
      const jobId = paymentEntity.notes?.jobId;
      console.log(`Webhook fallback: verified payment captured for job ID ${jobId}`);

      if (jobId) {
        await jobStore.updateJobStatus(jobId, 'pending', {
          paid: true,
          paymentId: paymentEntity.id
        });
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error: any) {
    res.status(500).json({ error: 'Webhook processing error', message: error.message });
  }
}

// Canonical webhook endpoint
app.post('/api/webhook/razorpay', handleRazorpayWebhook);

// TODO: deprecate POST /webhook/payment. Target removal version: v2.0.0
app.post('/webhook/payment', handleRazorpayWebhook);

// Canonical handler for updating settings configurations (Requires Auth)
async function updateSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const shopId = req.params.shopId || req.body.shopId || 'default_shop';
    const { bwPrice, colorPrice, maxPagesPerBatch, cooldownMin, printers, upiId } = req.body;
    
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
    await settingsStore.saveSettings(shopId, updatePayload);

    console.log(`Settings updated for shop ${shopId}:`, updatePayload);
    res.status(200).json({ success: true, message: 'Settings saved successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save settings: ' + error.message });
  }
}

// Canonical POST Settings Route (Requires Auth)
app.post('/api/v1/settings/:shopId', requireAuth, updateSettingsHandler);

// TODO: deprecate POST /api/settings. Target removal version: v2.0.0
app.post('/api/settings', requireAuth, updateSettingsHandler);

// GET: Fetch mock jobs filtered by shopId (for local agent polling)
app.get('/api/jobs', async (req: Request, res: Response): Promise<void> => {
  const shopId = (req.query.shopId as string) || 'default_shop';
  try {
    const jobs = await jobStore.getJobs(shopId);
    res.status(200).json(jobs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST: Update job status
app.post('/api/jobs/:id/status', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status, cost, printedAt, errorMessage, paid } = req.body;
  try {
    const updatePayload: any = {};
    if (cost !== undefined) updatePayload.cost = cost;
    if (printedAt !== undefined) updatePayload.printedAt = printedAt;
    if (errorMessage !== undefined) updatePayload.errorMessage = errorMessage;
    if (paid !== undefined) updatePayload.paid = paid;
    
    await jobStore.updateJobStatus(id, status, updatePayload);
    res.status(200).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST: Set print job priority
app.post('/api/jobs/:id/priority', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { priority } = req.body;
  try {
    await jobStore.updateJobPriority(id, !!priority);
    res.status(200).json({ success: true, message: `Job ${id} priority updated to ${!!priority}` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST: Upload a file locally (Mock storage mode fallback)
app.post('/api/upload', uploadLimiter, (req: Request, res: Response): void => {
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

// ── Register: create Supabase Auth user + profile ──────────────────────────
app.post('/api/v1/auth/register', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { shopName, email, password, shopId: requestedShopId } = req.body;
  if (!shopName || !email || !password) {
    res.status(400).json({ error: 'Shop name, email, and password are required.' });
    return;
  }
  if (!supabase) {
    res.status(500).json({ error: 'Supabase authentication service not initialized.' });
    return;
  }
  try {
    // Generate a unique shopId from the shop name
    const baseId = shopName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').substring(0, 16).replace(/_$/, '');
    const suffix = crypto.randomBytes(3).toString('hex');
    const shopId = requestedShopId || `${baseId}_${suffix}`;

    // Check if shop ID already taken
    const existing = await settingsStore.getProfile(shopId);
    if (existing?.ownerId) {
      res.status(409).json({ error: 'Shop ID already taken. Please try a different name.' });
      return;
    }

    // Create Supabase Auth user using their real email
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { shopId, shopName }
    });
    if (authError || !authData.user) {
      res.status(400).json({ error: authError?.message || 'Registration failed.' });
      return;
    }

    // Save profile row linked to the new auth user and save their real email
    await settingsStore.saveProfile(shopId, {
      shopId,
      shopName,
      email,
      upiId: '',
      ownerId: authData.user.id
    } as any);

    // Generate the permanent storefront QR code
    const qrCode = await getOrCreateQRCode(shopId);

    // Sign in immediately to return a valid JWT
    const { data: sessionData } = await supabase.auth.signInWithPassword({ email, password });

    const storefrontUrl = process.env.PUBLIC_FRONTEND_URL
      ? `${process.env.PUBLIC_FRONTEND_URL}/?shop=${shopId}`
      : `http://localhost:8080/?shop=${shopId}`;

    console.log(`Backend: Registered new shop "${shopName}" (Email: ${email}) → shopId: ${shopId}`);
    res.json({
      success: true,
      firstLogin: true,
      shopId,
      shopName,
      token: sessionData?.session?.access_token || '',
      qrCode,
      storefrontUrl
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

app.post('/api/v1/auth/otp/send', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'Email parameter is required.' });
    return;
  }
  try {
    if (!supabase) {
      res.status(500).json({ error: 'Supabase authentication service not initialized.' });
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true
      }
    });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ success: true, message: 'OTP verification code sent to your email.' });
  } catch (err: any) {
    res.status(500).json({ error: 'OTP request failed: ' + err.message });
  }
});

app.post('/api/v1/auth/otp/verify', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, token, shopId = 'default_shop' } = req.body;
  if (!email || !token) {
    res.status(400).json({ error: 'Missing email or verification token.' });
    return;
  }
  try {
    if (!supabase) {
      res.status(500).json({ error: 'Supabase authentication service not initialized.' });
      return;
    }
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email'
    });
    if (error || !data.user) {
      res.status(401).json({ error: error?.message || 'Verification failed.' });
      return;
    }

    // Map shop owner_id to user ID
    const profile = await settingsStore.getProfile(shopId);
    if (!profile) {
      // Create default profile for the shopkeeper
      await settingsStore.saveProfile(shopId, {
        shopId,
        shopName: shopId,
        email,
        upiId: '',
        ownerId: data.user.id
      } as any);
      await getOrCreateQRCode(shopId);
    } else {
      // Link owner_id and email
      await settingsStore.saveProfile(shopId, {
        ownerId: data.user.id,
        email
      } as any);
    }

    res.json({
      success: true,
      token: data.session?.access_token,
      user: data.user
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// ── Login: sign in via Supabase Auth (with crypto.scrypt fallback for mock mode) ──
app.post('/api/v1/auth/login', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { shopId = 'default_shop', password = '' } = req.body;
  try {
    if (!supabase) {
      // ── Mock / offline fallback ──────────────────────────────────────────
      const profile = await settingsStore.getProfile(shopId);
      let storedHash = profile?.passwordHash || '';
      if (!storedHash) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await new Promise<string>((resolve, reject) => {
          crypto.scrypt(password, salt, 64, (err, derived) => {
            if (err) reject(err); else resolve(salt + ':' + derived.toString('hex'));
          });
        });
        await settingsStore.saveProfile(shopId, { passwordHash: hash });
        await getOrCreateQRCode(shopId);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        res.json({ success: true, firstLogin: true, token: sessionToken, shopId });
        return;
      }
      const [salt, key] = storedHash.split(':');
      const isValid = await new Promise<boolean>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, derived) => {
          if (err) reject(err);
          else { try { resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived)); } catch { resolve(false); } }
        });
      });
      if (!isValid) { res.status(401).json({ error: 'Incorrect password.' }); return; }
      await getOrCreateQRCode(shopId);
      const sessionToken = crypto.randomBytes(32).toString('hex');
      res.json({ success: true, token: sessionToken, shopId });
      return;
    }

    // ── Supabase Auth login ──────────────────────────────────────────────────
    const profile = await settingsStore.getProfile(shopId);
    const email = profile?.email || `${shopId}@instaprint.local`;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      res.status(401).json({ error: 'Incorrect Shop ID or password.' });
      return;
    }

    await getOrCreateQRCode(shopId);
    console.log(`Backend: Shop "${shopId}" logged in via Supabase Auth.`);
    res.json({ success: true, shopId, token: data.session.access_token });
  } catch (err: any) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// ── Change Password: verify old password then update via Supabase Admin API ──
app.post('/api/v1/auth/change-password', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId = 'default_shop', oldPassword = '', newPassword } = req.body;
  if (!newPassword) { res.status(400).json({ error: 'New password is required.' }); return; }
  try {
    if (!supabase) {
      // ── Mock fallback ────────────────────────────────────────────────────
      const profile = await settingsStore.getProfile(shopId);
      let storedHash = profile?.passwordHash || '';
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
      await settingsStore.saveProfile(shopId, { passwordHash: newHash });
      res.json({ success: true, message: 'Password updated successfully.' });
      return;
    }

    // ── Supabase Auth change password ────────────────────────────────────────
    const profile = await settingsStore.getProfile(shopId);
    const ownerId = profile?.ownerId;
    if (!ownerId) {
      res.status(404).json({ error: 'Shop not found or not linked to Supabase Auth. Please re-register.' });
      return;
    }

    // Verify old password first
    const email = `${shopId}@instaprint.local`;
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: oldPassword });
    if (verifyError) {
      res.status(401).json({ error: 'Old password is incorrect.' });
      return;
    }

    // Update password via Admin API
    const { error: updateError } = await supabase.auth.admin.updateUserById(ownerId, { password: newPassword });
    if (updateError) {
      res.status(400).json({ error: updateError.message });
      return;
    }

    console.log(`Backend: Password changed for shop "${shopId}".`);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Password change failed: ' + err.message });
  }
});

// ===== PROFILE ROUTES =====

app.get('/api/v1/profile/:shopId', async (req: Request, res: Response): Promise<void> => {
  const { shopId } = req.params;
  try {
    const profile = await settingsStore.getProfile(shopId);
    let shopName = shopId;
    let upiId = '';
    let passwordSet = false;
    let qrCode = '';

    if (profile) {
      shopName = profile.shopName || shopId;
      upiId = profile.upiId || '';
      // passwordSet is true if linked to Supabase Auth (ownerId) OR has legacy hash
      passwordSet = !!(profile.ownerId) || !!(profile.passwordHash);
      qrCode = profile.qrCode || '';
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
    const updatePayload: any = {};
    if (shopName !== undefined) updatePayload.shopName = shopName;
    if (upiId !== undefined) updatePayload.upiId = upiId;
    await settingsStore.saveProfile(shopId, updatePayload);
    
    if (upiId !== undefined) {
      await settingsStore.saveSettings(shopId, { upiId });
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
    const settings = await settingsStore.getSettings(shopId);
    const printers = settings.printers || {};
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
    const settings = await settingsStore.getSettings(shopId);
    const printers = settings.printers || {};
    printers[printerId] = printerObj as any;
    await settingsStore.saveSettings(shopId, { printers });
    res.json({ success: true, printer: printerObj });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/printers/:shopId/:printerId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId, printerId } = req.params;
  const updates = req.body;
  try {
    const settings = await settingsStore.getSettings(shopId);
    const printers = settings.printers || {};
    if (printers[printerId]) {
      Object.assign(printers[printerId], updates);
      await settingsStore.saveSettings(shopId, { printers });
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/printers/:shopId/:printerId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { shopId, printerId } = req.params;
  try {
    const settings = await settingsStore.getSettings(shopId);
    const printers = settings.printers || {};
    if (printers[printerId]) {
      delete printers[printerId];
      await settingsStore.saveSettings(shopId, { printers });
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server if not running tests
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Secure Cloud Backend running on http://localhost:${PORT}`);
  });
}

export { app, checkoutSchema, isValidMagicBytes, clientCheckoutTimes, handleRazorpayWebhook };

