import * as admin from 'firebase-admin';
import { SupabaseClient } from '@supabase/supabase-js';

export interface KioskPrinter {
  id: string;
  name: string;
  maxPages: number;
  cooldownMin: number;
  colorMode: 'bw' | 'color' | 'both';
  paperSize?: string;
  scale?: string;
}

export interface ShopSettings {
  bwPrice: number | null;
  colorPrice: number | null;
  maxPagesPerBatch: number;
  cooldownMin: number;
  printers?: Record<string, KioskPrinter>;
  upiId?: string;
  recaptchaSiteKey?: string;
}

export interface ShopProfile {
  shopId: string;
  shopName: string;
  upiId: string;
  passwordHash?: string;
  ownerId?: string;       // Supabase auth.users UUID
  email?: string;         // Shopkeeper real email/gmail
  qrCode?: string;
  qrCodeUrl?: string;
}

export interface PrintJob {
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

export interface ISettingsStore {
  getSettings(shopId: string): Promise<ShopSettings>;
  saveSettings(shopId: string, settings: Partial<ShopSettings>): Promise<void>;
  getProfile(shopId: string): Promise<ShopProfile | null>;
  saveProfile(shopId: string, profile: Partial<ShopProfile>): Promise<void>;
}

export interface IJobStore {
  getJob(jobId: string): Promise<PrintJob | null>;
  getJobByToken(shopId: string, token: string): Promise<PrintJob | null>;
  getJobs(shopId: string): Promise<Record<string, PrintJob>>;
  enqueueJob(jobId: string, jobData: PrintJob): Promise<void>;
  updateJobStatus(jobId: string, status: string, extra?: Partial<PrintJob>): Promise<void>;
  updateJobPriority(jobId: string, priority: boolean): Promise<void>;
  incrementDailyToken(shopId: string, todayStr: string): Promise<number>;
  clearMockQueue(): void;
}

// In-Memory mock storage state
const mockSettingsStore: Record<string, ShopSettings> = {};
const mockProfilesStore: Record<string, ShopProfile> = {};
const mockJobsQueue: PrintJob[] = [];

export class MockSettingsStore implements ISettingsStore {
  async getSettings(shopId: string): Promise<ShopSettings> {
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

  async saveSettings(shopId: string, settings: Partial<ShopSettings>): Promise<void> {
    const current = await this.getSettings(shopId);
    Object.assign(current, settings);
  }

  async getProfile(shopId: string): Promise<ShopProfile | null> {
    if (!mockProfilesStore[shopId]) {
      mockProfilesStore[shopId] = {
        shopId,
        shopName: shopId,
        upiId: '',
        passwordHash: '',
        email: ''
      };
    }
    return mockProfilesStore[shopId];
  }

  async saveProfile(shopId: string, profile: Partial<ShopProfile>): Promise<void> {
    const current = await this.getProfile(shopId);
    if (current) {
      Object.assign(current, profile);
    }
  }
}

export class MockJobStore implements IJobStore {
  async getJob(jobId: string): Promise<PrintJob | null> {
    return mockJobsQueue.find(j => j.id === jobId) || null;
  }

  async getJobByToken(shopId: string, token: string): Promise<PrintJob | null> {
    return mockJobsQueue.find(j => j.shopId === shopId && j.tokenNumber === token) || null;
  }

  async getJobs(shopId: string): Promise<Record<string, PrintJob>> {
    const jobsObj: Record<string, PrintJob> = {};
    mockJobsQueue.forEach(j => {
      if (j.shopId === shopId) {
        jobsObj[j.id] = j;
      }
    });
    return jobsObj;
  }

  async enqueueJob(jobId: string, jobData: PrintJob): Promise<void> {
    const idx = mockJobsQueue.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      mockJobsQueue[idx] = jobData;
    } else {
      mockJobsQueue.push(jobData);
    }
  }

  async updateJobStatus(jobId: string, status: string, extra?: Partial<PrintJob>): Promise<void> {
    const job = mockJobsQueue.find(j => j.id === jobId);
    if (job) {
      job.status = status as any;
      if (extra) {
        Object.assign(job, extra);
      }
    }
  }

  async updateJobPriority(jobId: string, priority: boolean): Promise<void> {
    const job = mockJobsQueue.find(j => j.id === jobId);
    if (job) {
      job.priority = priority;
    }
  }

  async incrementDailyToken(shopId: string, todayStr: string): Promise<number> {
    const todayStrDay = todayStr.split('-')[2]; // e.g. '05'
    const todayJobs = mockJobsQueue.filter(j => j.shopId === shopId && j.tokenNumber.startsWith(`${todayStrDay}-`));
    return todayJobs.length + 1;
  }

  clearMockQueue(): void {
    mockJobsQueue.length = 0;
  }
}

export class FirebaseSettingsStore implements ISettingsStore {
  constructor(private db: admin.database.Database) {}

  async getSettings(shopId: string): Promise<ShopSettings> {
    const snap = await this.db.ref(`settings/${shopId}`).once('value');
    const val = snap.val();
    return {
      bwPrice: val?.bwPrice ?? null,
      colorPrice: val?.colorPrice ?? null,
      maxPagesPerBatch: val?.maxPagesPerBatch ?? 80,
      cooldownMin: val?.cooldownMin ?? 5,
      printers: val?.printers ?? {},
      upiId: val?.upiId ?? ''
    };
  }

  async saveSettings(shopId: string, settings: Partial<ShopSettings>): Promise<void> {
    await this.db.ref(`settings/${shopId}`).update(settings);
  }

  async getProfile(shopId: string): Promise<ShopProfile | null> {
    const snap = await this.db.ref(`profiles/${shopId}`).once('value');
    const val = snap.val();
    if (!val) return null;
    return {
      shopId,
      shopName: val.shopName || shopId,
      upiId: val.upiId || '',
      passwordHash: val.passwordHash || '',
      qrCode: val.qrCode || '',
      qrCodeUrl: val.qrCodeUrl || ''
    };
  }

  async saveProfile(shopId: string, profile: Partial<ShopProfile>): Promise<void> {
    await this.db.ref(`profiles/${shopId}`).update(profile);
  }
}

export class FirebaseJobStore implements IJobStore {
  constructor(private db: admin.database.Database) {}

  async getJob(jobId: string): Promise<PrintJob | null> {
    const snap = await this.db.ref(`print_queue/${jobId}`).once('value');
    return snap.val() as PrintJob | null;
  }

  async getJobByToken(shopId: string, token: string): Promise<PrintJob | null> {
    const snap = await this.db.ref('print_queue').once('value');
    const val = snap.val();
    if (!val) return null;
    return Object.values(val).find((j: any) => j.shopId === shopId && j.tokenNumber === token) as PrintJob | null;
  }

  async getJobs(shopId: string): Promise<Record<string, PrintJob>> {
    const snap = await this.db.ref('print_queue').once('value');
    const val = snap.val();
    const filtered: Record<string, PrintJob> = {};
    if (val) {
      Object.entries(val).forEach(([key, job]: [string, any]) => {
        if (job.shopId === shopId) {
          filtered[key] = job;
        }
      });
    }
    return filtered;
  }

  async enqueueJob(jobId: string, jobData: PrintJob): Promise<void> {
    await this.db.ref(`print_queue/${jobId}`).set(jobData);
  }

  async updateJobStatus(jobId: string, status: string, extra?: Partial<PrintJob>): Promise<void> {
    const payload: any = { status };
    if (extra) {
      Object.assign(payload, extra);
    }
    await this.db.ref(`print_queue/${jobId}`).update(payload);
  }

  async updateJobPriority(jobId: string, priority: boolean): Promise<void> {
    await this.db.ref(`print_queue/${jobId}`).update({ priority });
  }

  async incrementDailyToken(shopId: string, todayStr: string): Promise<number> {
    const counterRef = this.db.ref(`counters/${shopId}/${todayStr}`);
    const transactionResult = await counterRef.transaction((currentValue: number | null) => {
      return (currentValue || 0) + 1;
    });

    if (!transactionResult.committed) {
      throw new Error('Failed to generate token number. Transaction aborted.');
    }
    return transactionResult.snapshot.val() as number;
  }

  clearMockQueue(): void {}
}

export class SupabaseSettingsStore implements ISettingsStore {
  constructor(private client: SupabaseClient) {}

  async getSettings(shopId: string): Promise<ShopSettings> {
    const { data: settingsData, error: settingsError } = await this.client
      .from('settings')
      .select('*')
      .eq('shop_id', shopId)
      .maybeSingle();

    if (settingsError) {
      console.error(`SupabaseSettingsStore: Failed to get settings for ${shopId}:`, settingsError.message);
    }

    const { data: profileData, error: profileError } = await this.client
      .from('profiles')
      .select('upi_id')
      .eq('shop_id', shopId)
      .maybeSingle();

    if (profileError) {
      console.error(`SupabaseSettingsStore: Failed to get profile for ${shopId}:`, profileError.message);
    }

    return {
      bwPrice: settingsData?.bw_price ? Number(settingsData.bw_price) : null,
      colorPrice: settingsData?.color_price ? Number(settingsData.color_price) : null,
      maxPagesPerBatch: settingsData?.max_pages_per_batch ?? 80,
      cooldownMin: settingsData?.cooldown_min ?? 5,
      printers: settingsData?.printers ?? {},
      upiId: profileData?.upi_id ?? ''
    };
  }

  async saveSettings(shopId: string, settings: Partial<ShopSettings>): Promise<void> {
    const payload: any = { shop_id: shopId };
    if (settings.bwPrice !== undefined) payload.bw_price = settings.bwPrice;
    if (settings.colorPrice !== undefined) payload.color_price = settings.colorPrice;
    if (settings.maxPagesPerBatch !== undefined) payload.max_pages_per_batch = settings.maxPagesPerBatch;
    if (settings.cooldownMin !== undefined) payload.cooldown_min = settings.cooldownMin;
    if (settings.printers !== undefined) payload.printers = settings.printers;

    if (settings.upiId !== undefined) {
      const { error: profileError } = await this.client
        .from('profiles')
        .update({ upi_id: settings.upiId })
        .eq('shop_id', shopId);
      if (profileError) {
        console.error('Failed to save upiId to profiles table:', profileError.message);
      }
    }

    const { error } = await this.client
      .from('settings')
      .upsert(payload);

    if (error) {
      throw new Error('Failed to save settings: ' + error.message);
    }
  }

  async getProfile(shopId: string): Promise<ShopProfile | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select('*')
      .eq('shop_id', shopId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      shopId: data.shop_id,
      shopName: data.shop_name,
      upiId: data.upi_id || '',
      passwordHash: data.password_hash || '',
      ownerId: data.owner_id || '',
      email: data.email || '',
      qrCode: data.qr_code || '',
      qrCodeUrl: data.qr_code_url || ''
    };
  }

  async saveProfile(shopId: string, profile: Partial<ShopProfile>): Promise<void> {
    const current = await this.getProfile(shopId);
    const payload: any = {
      shop_id: shopId,
      shop_name: profile.shopName || current?.shopName || shopId,
      upi_id: profile.upiId !== undefined ? profile.upiId : (current?.upiId || ''),
      password_hash: profile.passwordHash !== undefined ? profile.passwordHash : (current?.passwordHash || ''),
      email: profile.email !== undefined ? profile.email : (current?.email || ''),
      qr_code: profile.qrCode !== undefined ? profile.qrCode : (current?.qrCode || ''),
      qr_code_url: profile.qrCodeUrl !== undefined ? profile.qrCodeUrl : (current?.qrCodeUrl || '')
    };
    if ((profile as any).ownerId) {
      payload.owner_id = (profile as any).ownerId;
    }

    const { error } = await this.client
      .from('profiles')
      .upsert(payload);

    if (error) {
      throw new Error('Failed to save profile: ' + error.message);
    }
  }
}

export class SupabaseJobStore implements IJobStore {
  constructor(private client: SupabaseClient) {}

  private mapToJob(data: any): PrintJob {
    return {
      id: data.id,
      fileUrl: data.file_url,
      printType: data.print_type,
      totalPages: data.total_pages,
      copies: data.copies,
      tokenNumber: data.token_number,
      status: data.status,
      paid: data.paid,
      cost: Number(data.cost),
      paymentId: data.payment_id,
      createdAt: new Date(data.created_at).getTime(),
      shopId: data.shop_id,
      errorMessage: data.error_message,
      printedAt: data.printed_at ? new Date(data.printed_at).getTime() : undefined,
      priority: data.priority,
      paperSize: data.paper_size
    };
  }

  async getJob(jobId: string): Promise<PrintJob | null> {
    const { data, error } = await this.client
      .from('print_queue')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (error || !data) return null;
    return this.mapToJob(data);
  }

  async getJobByToken(shopId: string, token: string): Promise<PrintJob | null> {
    const { data, error } = await this.client
      .from('print_queue')
      .select('*')
      .eq('shop_id', shopId)
      .eq('token_number', token)
      .maybeSingle();

    if (error || !data) return null;
    return this.mapToJob(data);
  }

  async getJobs(shopId: string): Promise<Record<string, PrintJob>> {
    const { data, error } = await this.client
      .from('print_queue')
      .select('*')
      .eq('shop_id', shopId);

    const jobsObj: Record<string, PrintJob> = {};
    if (data) {
      data.forEach(d => {
        jobsObj[d.id] = this.mapToJob(d);
      });
    }
    return jobsObj;
  }

  async enqueueJob(jobId: string, jobData: PrintJob): Promise<void> {
    const payload = {
      id: jobId,
      shop_id: jobData.shopId,
      file_url: jobData.fileUrl,
      print_type: jobData.printType,
      total_pages: jobData.totalPages,
      copies: jobData.copies,
      token_number: jobData.tokenNumber,
      status: jobData.status,
      paid: jobData.paid,
      cost: jobData.cost,
      payment_id: jobData.paymentId || '',
      created_at: jobData.createdAt ? new Date(jobData.createdAt).toISOString() : new Date().toISOString(),
      printed_at: jobData.printedAt ? new Date(jobData.printedAt).toISOString() : null,
      priority: !!jobData.priority,
      paper_size: jobData.paperSize || 'A4',
      error_message: jobData.errorMessage || ''
    };

    const { error } = await this.client
      .from('print_queue')
      .upsert(payload);

    if (error) {
      throw new Error('Failed to enqueue job: ' + error.message);
    }
  }

  async updateJobStatus(jobId: string, status: string, extra?: Partial<PrintJob>): Promise<void> {
    const payload: any = { status };
    if (extra) {
      if (extra.paid !== undefined) payload.paid = extra.paid;
      if (extra.paymentId !== undefined) payload.payment_id = extra.paymentId;
      if (extra.printedAt !== undefined) payload.printed_at = extra.printedAt ? new Date(extra.printedAt).toISOString() : null;
      if (extra.errorMessage !== undefined) payload.error_message = extra.errorMessage;
      if (extra.cost !== undefined) payload.cost = extra.cost;
    }

    const { error } = await this.client
      .from('print_queue')
      .update(payload)
      .eq('id', jobId);

    if (error) {
      throw new Error('Failed to update job status: ' + error.message);
    }
  }

  async updateJobPriority(jobId: string, priority: boolean): Promise<void> {
    const { error } = await this.client
      .from('print_queue')
      .update({ priority })
      .eq('id', jobId);

    if (error) {
      throw new Error('Failed to update job priority: ' + error.message);
    }
  }

  async incrementDailyToken(shopId: string, todayStr: string): Promise<number> {
    const { data, error } = await this.client
      .rpc('increment_daily_token', { p_shop_id: shopId, p_day_str: todayStr });

    if (error) {
      throw new Error('Failed to increment daily token: ' + error.message);
    }
    return data as number;
  }

  clearMockQueue(): void {}
}

export let settingsStore: ISettingsStore;
export let jobStore: IJobStore;

export function initializeStores(db?: admin.database.Database, supabase?: SupabaseClient) {
  if (supabase) {
    settingsStore = new SupabaseSettingsStore(supabase);
    jobStore = new SupabaseJobStore(supabase);
    console.log('Stores initialized with Supabase backing.');
  } else if (db) {
    settingsStore = new FirebaseSettingsStore(db);
    jobStore = new FirebaseJobStore(db);
    console.log('Stores initialized with Firebase backing.');
  } else {
    settingsStore = new MockSettingsStore();
    jobStore = new MockJobStore();
    console.log('Stores initialized with Mock In-Memory backing.');
  }
}
