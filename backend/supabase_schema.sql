-- =====================================================================
-- INSTAPRINT KIOSK DB SCHEMA (SUPABASE POSTGRESQL)
-- =====================================================================

-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Profiles Table
CREATE TABLE IF NOT EXISTS public.profiles (
  shop_id TEXT PRIMARY KEY,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT DEFAULT '',
  shop_name TEXT NOT NULL,
  upi_id TEXT DEFAULT '',
  password_hash TEXT DEFAULT '',
  qr_code TEXT DEFAULT '',
  qr_code_url TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Settings Table
CREATE TABLE IF NOT EXISTS public.settings (
  shop_id TEXT PRIMARY KEY REFERENCES public.profiles(shop_id) ON DELETE CASCADE,
  bw_price NUMERIC DEFAULT NULL,
  color_price NUMERIC DEFAULT NULL,
  max_pages_per_batch INTEGER DEFAULT 80 NOT NULL,
  cooldown_min INTEGER DEFAULT 5 NOT NULL,
  printers JSONB DEFAULT '{}'::jsonb NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Print Queue (Jobs) Table
CREATE TABLE IF NOT EXISTS public.print_queue (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES public.profiles(shop_id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  print_type TEXT CHECK (print_type IN ('bw', 'color')) NOT NULL,
  total_pages INTEGER NOT NULL,
  copies INTEGER NOT NULL,
  token_number TEXT NOT NULL,
  status TEXT CHECK (status IN ('pending', 'pending_payment', 'printing', 'completed', 'failed')) DEFAULT 'pending_payment' NOT NULL,
  paid BOOLEAN DEFAULT false NOT NULL,
  cost NUMERIC NOT NULL,
  payment_id TEXT DEFAULT '' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  printed_at TIMESTAMPTZ,
  priority BOOLEAN DEFAULT false NOT NULL,
  paper_size TEXT DEFAULT 'A4' NOT NULL,
  error_message TEXT DEFAULT ''
);

-- 4. Daily Token Counters Table
CREATE TABLE IF NOT EXISTS public.daily_token_counters (
  shop_id TEXT REFERENCES public.profiles(shop_id) ON DELETE CASCADE,
  day_str TEXT NOT NULL, -- Format: YYYY-MM-DD
  counter INTEGER DEFAULT 0 NOT NULL,
  PRIMARY KEY (shop_id, day_str)
);

-- --- Enable Row Level Security (RLS) ---
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.print_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_token_counters ENABLE ROW LEVEL SECURITY;

-- --- Row Level Security (RLS) Access Policies ---

-- 1. Profiles Policies
CREATE POLICY "Public read profiles"
  ON public.profiles
  FOR SELECT
  USING (true);

CREATE POLICY "Owners can insert their profiles"
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update their profiles"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can delete their profiles"
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (owner_id = auth.uid());

-- 2. Settings Policies
CREATE POLICY "Public read settings"
  ON public.settings
  FOR SELECT
  USING (true);

CREATE POLICY "Owners can insert settings"
  ON public.settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = settings.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can update settings"
  ON public.settings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = settings.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = settings.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can delete settings"
  ON public.settings
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = settings.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  );

-- 3. Print Queue (Jobs) Policies
CREATE POLICY "Public insert print queue"
  ON public.print_queue
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public read print queue"
  ON public.print_queue
  FOR SELECT
  USING (true);

CREATE POLICY "Owners can update print queue"
  ON public.print_queue
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = print_queue.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = print_queue.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can delete print queue"
  ON public.print_queue
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE profiles.shop_id = print_queue.shop_id 
        AND profiles.owner_id = auth.uid()
    )
  );

-- 4. Daily Token Counters Policies
CREATE POLICY "Public insert daily token counters"
  ON public.daily_token_counters
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public select daily token counters"
  ON public.daily_token_counters
  FOR SELECT
  USING (true);

CREATE POLICY "Public update daily token counters"
  ON public.daily_token_counters
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- --- RPC Functions ---

-- Atomic daily token counter increment function
CREATE OR REPLACE FUNCTION public.increment_daily_token(p_shop_id text, p_day_str text)
RETURNS integer AS $$
DECLARE
  v_counter integer;
BEGIN
  INSERT INTO public.daily_token_counters (shop_id, day_str, counter)
  VALUES (p_shop_id, p_day_str, 1)
  ON CONFLICT (shop_id, day_str)
  DO UPDATE SET counter = daily_token_counters.counter + 1
  RETURNING counter INTO v_counter;
  RETURN v_counter;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
