const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const firebaseDbUrl = process.env.FIREBASE_DATABASE_URL;
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Migration Aborted: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function runMigration() {
  console.log('Starting Firebase to Supabase Data Migration...');
  
  // 1. Initialize Firebase if possible
  let firebaseDb;
  const absoluteServiceAccountPath = path.resolve(serviceAccountPath);
  if (fs.existsSync(absoluteServiceAccountPath) && firebaseDbUrl) {
    const serviceAccount = JSON.parse(fs.readFileSync(absoluteServiceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: firebaseDbUrl,
    });
    firebaseDb = admin.database();
    console.log('Connected to Firebase Realtime Database.');
  } else {
    console.warn('Firebase service account key or database URL missing. Skipping Firebase pull.');
    return;
  }

  try {
    // A. Migrate Profiles
    console.log('Fetching profiles from Firebase...');
    const profilesSnap = await firebaseDb.ref('profiles').once('value');
    const profilesVal = profilesSnap.val();
    if (profilesVal) {
      const profileEntries = Object.entries(profilesVal);
      console.log(`Migrating ${profileEntries.length} profiles...`);
      for (const [shopId, data] of profileEntries) {
        const { error } = await supabase.from('profiles').upsert({
          shop_id: shopId,
          shop_name: data.shopName || shopId,
          upi_id: data.upiId || '',
          password_hash: data.passwordHash || '',
          qr_code: data.qrCode || '',
          qr_code_url: data.qrCodeUrl || ''
        });
        if (error) {
          console.error(`Error migrating profile for shop ${shopId}:`, error.message);
        }
      }
    }

    // B. Migrate Settings
    console.log('Fetching settings from Firebase...');
    const settingsSnap = await firebaseDb.ref('settings').once('value');
    const settingsVal = settingsSnap.val();
    if (settingsVal) {
      const settingsEntries = Object.entries(settingsVal);
      console.log(`Migrating ${settingsEntries.length} settings...`);
      for (const [shopId, data] of settingsEntries) {
        const { error } = await supabase.from('settings').upsert({
          shop_id: shopId,
          bw_price: data.bwPrice !== undefined ? data.bwPrice : null,
          color_price: data.colorPrice !== undefined ? data.colorPrice : null,
          max_pages_per_batch: data.maxPagesPerBatch ?? 80,
          cooldown_min: data.cooldownMin ?? 5,
          printers: data.printers || {}
        });
        if (error) {
          console.error(`Error migrating settings for shop ${shopId}:`, error.message);
        }
      }
    }

    // C. Migrate Print Queue (Jobs)
    console.log('Fetching print queue jobs from Firebase...');
    const queueSnap = await firebaseDb.ref('print_queue').once('value');
    const queueVal = queueSnap.val();
    if (queueVal) {
      const jobEntries = Object.entries(queueVal);
      console.log(`Migrating ${jobEntries.length} print queue jobs...`);
      for (const [jobId, data] of jobEntries) {
        const { error } = await supabase.from('print_queue').upsert({
          id: jobId,
          shop_id: data.shopId,
          file_url: data.fileUrl,
          print_type: data.printType,
          total_pages: data.totalPages,
          copies: data.copies,
          token_number: data.tokenNumber,
          status: data.status,
          paid: data.paid,
          cost: data.cost,
          payment_id: data.paymentId || '',
          created_at: data.createdAt ? new Date(data.createdAt).toISOString() : new Date().toISOString(),
          printed_at: data.printedAt ? new Date(data.printedAt).toISOString() : null,
          priority: !!data.priority,
          paper_size: data.paperSize || 'A4',
          error_message: data.errorMessage || ''
        });
        if (error) {
          console.error(`Error migrating job ${jobId}:`, error.message);
        }
      }
    }

    // D. Migrate Daily Counters
    console.log('Fetching daily counters from Firebase...');
    const countersSnap = await firebaseDb.ref('counters').once('value');
    const countersVal = countersSnap.val();
    if (countersVal) {
      let counterCount = 0;
      for (const [shopId, dates] of Object.entries(countersVal)) {
        if (dates && typeof dates === 'object') {
          for (const [dayStr, count] of Object.entries(dates)) {
            const { error } = await supabase.from('daily_token_counters').upsert({
              shop_id: shopId,
              day_str: dayStr,
              counter: count
            });
            if (error) {
              console.error(`Error migrating counter for shop ${shopId} day ${dayStr}:`, error.message);
            } else {
              counterCount++;
            }
          }
        }
      }
      console.log(`Migrating ${counterCount} token counter entries...`);
    }

    console.log('=====================================================================');
    console.log('🎉 Firebase to Supabase Data Migration Completed Successfully!');
    console.log('=====================================================================');
  } catch (err) {
    console.error('Migration failed with unexpected error:', err.message);
  } finally {
    process.exit(0);
  }
}

runMigration();
