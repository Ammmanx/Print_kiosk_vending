# 🍏 InstaPrint: Self-Service Kiosk Printing System
## Complete Project Context & Technical Specifications

InstaPrint is a complete, self-service kiosk printing solution designed for shopkeepers. It allows customers to scan a QR code at a storefront, upload documents or images, configure layouts (grids, A4 sizing, margins, copies), and pay via UPI or Razorpay from their phones. The local print agent running on the shopkeeper's PC polls the cloud server, downloads the print jobs, and routes them to physical printers connected to the local OS.

---

## 🏗️ 1. System Architecture

The project is structured around three core architectural modules that operate in a client-server-spooler topology:

```
+---------------------------+              +---------------------------+
|    Customer Storefront    |              |     Secure API Backend    |
|   (Mobile Web Web App)    |              |   (TypeScript / Express)  |
|  - File Uploads & Grids   |  HTTP POST   |  - Order / Billing Management|
|  - Razorpay/UPI Checkout  |------------->|  - Database Synchronization|
|  - Status & ETA Polling   |              |  - File upload / cleanup  |
+---------------------------+              +---------------------------+
             ^                                           ^
             |                                           |
             | HTTP GET                                  | Cloud Sync / Polling
             | (Status check)                            | (JSON API or Firebase)
             |                                           v
             |                             +---------------------------+
             |                             |     Local Print Agent     |
             +-----------------------------|    (Node.js / Express)    |
                                           |  - Offline Spooler Journal|
                                           |  - Cooldown Safety Checks |
                                           |  - Local Operator Console |
                                           +---------------------------+
                                                         |
                                                         | spool job
                                                         v
                                           +---------------------------+
                                           |    Physical OS Printer    |
                                           |     (Color or B&W USB)    |
                                           +---------------------------+
```

1. **Customer Storefront (`/frontend`)**: A fully responsive mobile-tailored web interface. Customers scan a shop-specific QR code to access the catalog, upload multiple files (PDFs, images, documents), format images onto single/multi-page aspect ratio layout grids (e.g. passport photo packing), calculate checkout costs, and initiate payments.
2. **API Backend Server (`/backend`)**: An Express TypeScript server. It acts as the central orchestrator for security, payment gateway webhooks, authentication, storefront QR code generation, queue management, and SMS/Email notifications. It abstractly supports Firebase, Supabase, or local memory stores.
3. **Local Print Agent (`/agent`)**: A Node.js application running locally on the shopkeeper's PC next to physical USB/network printers. It polls the backend API, downloads documents, manages print channels, verifies safety limits (cooldown checks), and dispatches jobs to physical Windows printers. It also hosts the Shopkeeper Console locally on port 3000.

---

## 📂 2. Repository Directory Structure

```
print vending/
├── InstaPrint-Agent-Distribution/    # Distributed pre-compiled agent packages for shopkeepers
│   ├── .env                           # Local distribution configuration
│   ├── InstaPrint-Agent.exe           # Compiled Node binary executable via pkg
│   └── README.txt                     # Distribution instructions for operators
├── agent/                             # Local PC Print Agent Source Code
│   ├── dist/                          # Compiled JS artifacts
│   ├── mock_prints/                   # Saved PDFs when running in physical printer mock mode
│   ├── node_modules/                  # Local dependencies
│   ├── .env                           # Agent local configurations
│   ├── .env.example                   # Template config for agent setups
│   ├── agent.js                       # Main agent daemon & Port 3000 local Express console server
│   ├── config.json                    # Persisted printer mapping and safety configurations
│   ├── dashboard.html                 # Shopkeeper Console dashboard web UI
│   ├── jobs_journal.json              # Local journal buffer for offline durability
│   ├── package-lock.json              # Lockfile
│   └── package.json                   # Dependencies: pdf-to-printer, pdf-lib, firebase-admin, etc.
├── backend/                           # Cloud API Server Source Code
│   ├── dist/                          # Compiled TS output
│   ├── node_modules/                  # Server dependencies
│   ├── uploads/                       # Temporary store for customer uploaded documents
│   ├── .env                           # Server environment configurations
│   ├── .env.example                   # Template config for server environment
│   ├── jest.config.js                 # Testing suite configuration
│   ├── migrate_to_supabase.js         # Migration utility from Firebase to Supabase
│   ├── notifications.log              # Audit log for notification fallbacks
│   ├── package-lock.json              # Lockfile
│   ├── package.json                   # Dependencies: express, helmet, razorpay, nodemailer, zod
│   ├── server.test.ts                 # Integration Jest test suite for API endpoints
│   ├── server.ts                      # Main entrypoint, middleware, routes, and security validators
│   ├── stores.ts                      # Abstraction layer for Firebase, Supabase, and Mock storage
│   ├── supabase_schema.sql            # Supabase database table definitions, RLS, and RPCs
│   └── tsconfig.json                  # TypeScript compiler options
├── frontend/                          # Customer Web Storefront Source Code
│   ├── node_modules/                  # HTTP Server local dependencies
│   ├── app.js                         # Core client logic, page counters, Razorpay checkout, canvas previews
│   ├── index.html                     # Customer mobile storefront viewport
│   ├── index.css                      # Styling (modern dark UI, glassmorphic modules, HSL variables)
│   ├── manifest.json                  # Web App Manifest for progressive installation
│   ├── package-lock.json              # Lockfile
│   ├── package.json                   # Development server config
│   └── sw.js                          # Service Worker for cache assets and offline loading
├── package.json                       # Root script orchestrator and concurrency runner
├── package-lock.json                  # Root lockfile
├── README.md                          # Repository introduction and guides
├── start_kiosk.js                     # Root automation startup and configuration synchronizer
├── Start Kiosk.bat                    # Double-click script to run start_kiosk.js
├── run_shopkeeper.bat                 # Double-click script to launch local console
├── cloudflared.exe                    # Exposes local development ports to public URL mappings
└── LICENSE.txt                        # MIT License
```

---

## 🛠️ 3. Detailed Component & File Analysis

### 3.1 Root Orchestration
*   **[start_kiosk.js](file:///d:/print%20vending/start_kiosk.js)**: 
    A startup coordinator. It launches `cloudflared.exe` to establish public web tunnels for port 5002 (Backend) and port 8080 (Storefront). It monitors the stdout of the Cloudflare sub-processes to parse the generated subdomains (e.g. `https://xxx.trycloudflare.com`), automatically updates the API endpoint variables inside `frontend/app.js`, and modifies `.env` configuration files for both the agent and backend with the active public URLs. It then concurrently spawns the backend server, print agent, and frontend static server, and opens the local dashboard in the browser.

### 3.2 Customer Storefront (`/frontend`)
*   **[index.html](file:///d:/print%20vending/frontend/index.html)**: 
    The layout for customer mobile browsers. Employs a single-page app layout with dynamic screens (Upload Panel, Layout Settings Panel, Printing Progress View, Receipt Ticket View). Includes custom drag-and-drop components, layout preset selectors, image grid counters, payment methods, and error dialog overlays.
*   **[app.js](file:///d:/print%20vending/frontend/app.js)**: 
    Coordinates the customer-side lifecycle.
    1.  **File Management & Page Counting**: Reads uploaded files. If the file is a PDF, it loads `pdf-lib` client-side to extract the exact page count dynamically. If it is a text document, it estimates the total sheets based on line count (55 lines per page).
    2.  **Smart Packing & Grids**: Arranges uploaded images onto physical A4 layouts. Offers presets (1, 2, 4, 6, 8 images per page). Implements a smart grid packer layout to minimize margins and pack photos tightly.
    3.  **Payment Integrations**: Handles payment gateways. If in *Live Mode*, it queries the backend `/api/v1/payments` route to initialize a Razorpay order, loads the Razorpay checkout overlay on the phone, and verifies payment. If in *Demo Mode* (toggled via interface), it bypasses Razorpay, sends a checkout request with status `pending` directly, and displays a "Simulate Successful Payment" button.
    4.  **Telemetry Polling**: Once the order is submitted, it continuously queries `/api/v1/pickup/:token` every 3 seconds to update the customer on queue changes, print states (pending -> printing -> completed/failed), and ETA countdowns.
*   **[index.css](file:///d:/print%20vending/frontend/index.css)**: 
    Provides a glassmorphism style using CSS variables. Structured with strict layout containers, rich dark HSL palettes, smooth micro-animations, clear grid rules, and responsive media queries.

### 3.3 Secure Cloud API Server (`/backend`)
*   **[server.ts](file:///d:/print%20vending/backend/server.ts)**: 
    The central API service. Built using Express and TypeScript.
    1.  **Strict Security Guards**: Integrates `helmet` for cross-origin security, registers a global `express-rate-limit` (100 requests / 15 mins), and mounts specialized limiters for auth endpoints, file uploads (5 requests / min), and checkout attempts.
    2.  **Magic-Byte Binary Inspection**: To prevent malicious file upload exploits, it inspects the first 4 to 12 bytes of uploaded base64 data to verify matching binary headers (signatures for genuine PDFs, PNGs, JPEGs, and WEBPs) and rejects disguised formats.
    3.  **Storage Cleaner**: Runs a background worker interval every 5 minutes to clear out uploads older than 30 minutes.
    4.  **Checkout & Validation**: Uses `zod` to validate all payloads, calculates costs based on shop settings, increments daily print tokens atomically, and fires alerts (SMS queue writes, SMTP email alerts, FCM shopkeeper alerts).
*   **[stores.ts](file:///d:/print%20vending/backend/stores.ts)**: 
    An abstract data access layer implementing `ISettingsStore` and `IJobStore`. Connects to:
    -   *Firebase Realtime Database*: For real-time updates to print queues.
    -   *Supabase*: Connects using PostgreSQL clients with Row Level Security (RLS) policies.
    -   *Local Memory Fallback*: Used if external configurations are absent.
*   **[supabase_schema.sql](file:///d:/print%20vending/backend/supabase_schema.sql)**: 
    Database schema script. Creates tables (`profiles`, `settings`, `print_queue`, `daily_token_counters`), binds constraints, configures Row Level Security (RLS), and registers the plpgsql function `increment_daily_token` to guarantee atomic serial counter updates.

### 3.4 Local Print Agent (`/agent`)
*   **[agent.js](file:///d:/print%20vending/agent/agent.js)**: 
    The print agent executor.
    1.  **Cloud Sync & Polling**: Uses Firebase live listening or falls back to polling `/api/jobs` every 3 seconds to fetch pending jobs.
    2.  **Durability Spooler**: Writes to `jobs_journal.json`. If network connectivity is lost during printing, it retains the local job state and reconciles it back to the cloud once online.
    3.  **Printing Dispatcher**: Downloads document files, validates them, stamps print metadata onto page margins if needed, and uses `pdf-to-printer` to interact directly with local Windows spooler drivers. Supports both Black & White and Color printer channels.
    4.  **Dashboard Host**: Serves the Shopkeeper Dashboard console on port 3000.
*   **[dashboard.html](file:///d:/print%20vending/agent/dashboard.html)**: 
    The console web interface for shopkeepers. Displays the print queues categorized by status. Groups pending, printing, or failed print orders at the top, and completed orders at the bottom. Allows the operator to manage printer mappings, change pricing settings, configure maximum batch pages, and monitor safety alerts.

---

## 🔒 4. Security Infrastructure & Guards

InstaPrint implements multi-layered security gates to protect both the cloud infrastructure and the local print agent:

```
[Customer Upload Request]
           │
           ▼
┌──────────────────────────────────────┐
│  Rate Limiters (Global, Upload, etc)  │ --> Blocks high-volume spam
└──────────────────────────────────────┘
           │ Passed
           ▼
┌──────────────────────────────────────┐
│   reCAPTCHA v3 Bot Verification      │ --> Blocks automated scripts/bots
└──────────────────────────────────────┘
           │ Passed
           ▼
┌──────────────────────────────────────┐
│  Magic-Byte Binary Inspection Check  │ --> Rejects renamed executables/malware
└──────────────────────────────────────┘
           │ Verified
           ▼
┌──────────────────────────────────────┐
│   Zod Schema Validation Guard        │ --> Rejects malicious/malformed JSON payloads
└──────────────────────────────────────┘
           │ Valid
           ▼
   [File Accepted & Queued]
```

1.  **Rate Limiting**: Structured limiters are mounted per IP:
    *   *Global Rate Limiter*: 100 requests per 15 minutes.
    *   *Auth Limiter*: 5 login attempts per 15 minutes.
    *   *Upload Limiter*: 5 file uploads per minute.
    *   *Checkout Client Limiter*: 3 checkouts per minute.
    *   *Checkout Shop Limiter*: 5 checkouts per minute (grouped by shopId).
2.  **Magic-Byte Binary Validation**: Checks binary file signatures rather than file extensions. This prevents attackers from uploading executable files renamed to `.pdf` or `.png`.
3.  **Timing-Safe Signature Matching**: Razorpay payment signatures are validated using `crypto.timingSafeEqual` to prevent side-channel timing attacks that try to guess secrets.
4.  **Google reCAPTCHA v3 Protection**: Binds verification tokens on checkout and payment paths to block automated bots.
5.  **Supabase Row Level Security (RLS)**: Enforces policies on database tables so that authenticated owners can edit settings or profiles, while storefront operations can only insert print queue items.

---

## 💾 5. Database Schema & Storage Structures

### 5.1 Supabase Schema Table Specifications

#### 1. Table: `public.profiles`
Stores shopkeeper profiles and credential settings.
*   `shop_id` (TEXT, PRIMARY KEY): The unique slug for the shop.
*   `owner_id` (UUID, FOREIGN KEY -> auth.users): Relates to Supabase Auth accounts.
*   `email` (TEXT): Operator email.
*   `shop_name` (TEXT): Human-readable shop label.
*   `upi_id` (TEXT): Destination UPI address.
*   `password_hash` (TEXT): Encrypted local password hash.
*   `qr_code` (TEXT): Base64 data URI of the storefront QR code.
*   `qr_code_url` (TEXT): Core URL pointing to the customer storefront.
*   `created_at` (TIMESTAMPTZ): Entry creation timestamp.

#### 2. Table: `public.settings`
Stores dynamic parameters for shop transactions.
*   `shop_id` (TEXT, PRIMARY KEY, FOREIGN KEY -> profiles): Target shop link.
*   `bw_price` (NUMERIC): Price per black and white sheet.
*   `color_price` (NUMERIC): Price per color sheet.
*   `max_pages_per_batch` (INTEGER, Default: 80): Max printable sheets in single orders.
*   `cooldown_min` (INTEGER, Default: 5): Wait duration for print channels after batch completions.
*   `printers` (JSONB): Mapped active OS printers.

#### 3. Table: `public.print_queue`
Main queue holding customer jobs.
*   `id` (TEXT, PRIMARY KEY): Unique print job identifier.
*   `shop_id` (TEXT, FOREIGN KEY -> profiles): Target shop link.
*   `file_url` (TEXT): URL to the uploaded document file.
*   `print_type` (TEXT): Mode selection (`bw`, `color`).
*   `total_pages` (INTEGER): Estimated print pages.
*   `copies` (INTEGER): Print copy amount.
*   `token_number` (TEXT): Counter token formatted as `DD-Counter`.
*   `status` (TEXT): Progress mode (`pending`, `pending_payment`, `printing`, `completed`, `failed`).
*   `paid` (BOOLEAN): Payment status.
*   `cost` (NUMERIC): Total calculated billing fee.
*   `payment_id` (TEXT): Gateway order reference.
*   `created_at` (TIMESTAMPTZ): Insertion timestamp.
*   `printed_at` (TIMESTAMPTZ): Finalized timestamp.
*   `priority` (BOOLEAN): Flag for manual queue overrides.
*   `paper_size` (TEXT): Paper format (`A4`, `Letter`, etc).
*   `error_message` (TEXT): Error logs if a job fails.

#### 4. Table: `public.daily_token_counters`
Atomically manages the token counter sequence.
*   `shop_id` (TEXT, PRIMARY KEY): Shop link.
*   `day_str` (TEXT, PRIMARY KEY): Date key (`YYYY-MM-DD`).
*   `counter` (INTEGER): Incrementing count.

---

## 📡 6. Complete API Endpoints Reference

| Method | Endpoint | Auth | Request Body | Response Payload | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **GET** | `/health` | None | None | `{ "status": "healthy", "timestamp": "..." }` | Health check endpoint. |
| **GET** | `/api/v1/settings/:shopId` | None | None | `{ "bwPrice": 2, "colorPrice": 10, "maxPagesPerBatch": 80, "cooldownMin": 5, "printers": {...}, "recaptchaSiteKey": "..." }` | Retrieves pricing and limits for the storefront. |
| **POST** | `/api/v1/payments` | Captcha, Rate Limit | `{ "printType": "bw", "totalPages": 5, "copies": 1, "clientId": "...", "shopId": "..." }` | `{ "orderId": "order_...", "amount": 1000, "currency": "INR", "keyId": "..." }` | Generates a Razorpay order or returns mock orders in demo environments. |
| **POST** | `/api/checkout` | Rate Limit | `{ "fileUrl": "...", "printType": "bw", "totalPages": 5, "copies": 1, "payment": { "orderId": "...", "paymentId": "...", "signature": "..." }, "clientId": "...", "customerContact": "...", "shopId": "...", "status": "pending" }` | `{ "success": true, "message": "...", "tokenNumber": "12-1", "jobId": "...", "eta": "2 min" }` | Validates payments, increments daily token, and queues the print job. |
| **GET** | `/api/v1/pickup/:token` | None | None | `{ "token": "12-1", "status": "pending", "totalPages": 5, "copies": 1, "cost": 10, "eta": "2 min" }` | Customer endpoint to monitor print status and queue changes. |
| **PUT** | `/api/v1/orders/:token/status` | None | `{ "status": "completed", "errorMessage": "..." }` | `{ "success": true, "message": "..." }` | Updates order state using the print token. |
| **POST** | `/api/webhook/razorpay` | Webhook Secret | Raw Razorpay Webhook Payload | `{ "status": "ok" }` | Processes payment validation updates from Razorpay asynchronously. |
| **POST** | `/api/v1/settings/:shopId` | Auth Token | `{ "bwPrice": 2, "colorPrice": 10, "maxPagesPerBatch": 80, "cooldownMin": 5, "printers": {...}, "upiId": "..." }` | `{ "success": true, "message": "..." }` | Saves customized pricing, printer configs, and limits. |
| **GET** | `/api/jobs` | None | Query: `shopId` | `Record<string, PrintJob>` | Polling route for local print agent to download active queues. |
| **POST** | `/api/jobs/:id/status` | None | `{ "status": "completed", "cost": 10, "printedAt": 123456, "errorMessage": "...", "paid": true }` | `{ "success": true }` | Endpoint for the agent to report printing statuses. |
| **POST** | `/api/jobs/:id/priority` | None | `{ "priority": true }` | `{ "success": true, "message": "..." }` | Updates job priority to override standard FIFO queues. |
| **POST** | `/api/upload` | Upload Limit | `{ "filename": "...", "fileData": "..." }` | `{ "url": "...", "filePath": "..." }` | Accepts file uploads. Inspects binary magic bytes and saves files to disk. |
| **GET** | `/api/v1/printers/:shopId` | None | None | `{ "printers": {...} }` | Lists active local printers mapped to the shop. |
| **POST** | `/api/v1/printers/:shopId` | Auth Token | `{ "name": "Printer1", "colorMode": "bw", "maxPages": 80, "cooldownMin": 5 }` | `{ "success": true, "printer": {...} }` | Registers a new printer mapping. |
| **DELETE** | `/api/v1/printers/:shopId/:printerId` | Auth Token | None | `{ "success": true }` | Removes printer mappings. |

---

## ⚡ 7. Core System Processes & Logics

### 7.1 Kiosk Launch & Configuration Orchestration
```
   [start_kiosk.js]
          │
          ├─► 1. Run cloudflared.exe (Backend Tunnel, Port 5002)
          ├─► 2. Run cloudflared.exe (Frontend Tunnel, Port 8080)
          │
          ▼
   [Parse Tunnel Subdomains] ──► Parse logs for "*.trycloudflare.com"
          │
          ▼
   [Configure Core Configs]
          │
          ├─► Rewrite API_BASE_URL inside "frontend/app.js"
          ├─► Inject PUBLIC_FRONTEND_URL inside "backend/.env"
          ├─► Inject PUBLIC_FRONTEND_URL & API_URL inside "agent/.env"
          │
          ▼
   [Process Launcher]
          │
          ├─► Spawn "node dist/server.js" (Backend, Port 5002)
          ├─► Spawn "node agent.js" (Local Print Agent, Port 3000)
          ├─► Spawn "npx http-server ." (Frontend, Port 8080)
          │
          ▼
   [Open Browser Web View] ──► Open Local Dashboard "http://localhost:3000"
```

### 7.2 Customer File Upload & Checkout Flow
```
   [Storefront (app.js)]
          │
          ├──► 1. Select documents / images
          ├──► 2. Run client-side PDF-lib page counter extraction
          ├──► 3. Configure grid templates (pack images onto pages)
          │
          ▼
   [File Upload] ──► Post base64 payload to "/api/upload"
          │
          ▼
   [Backend (server.ts)]
          │
          ├─► 1. Run express-rate-limit validation checks
          ├─► 2. Inspect first 4-12 bytes for Magic-Byte binary signatures
          ├─► 3. Reject execution scripts, save file, and return URL
          │
          ▼
   [Storefront Checkout]
          │
          ├─► Query "/api/v1/payments" to build Razorpay payment orders
          ├─► Run payment gateway (Simulated Checkout or Razorpay modal)
          ├─► Post transaction tokens to "/api/checkout"
          │
          ▼
   [Backend Finalization]
          │
          ├─► 1. Verify signatures with timing-safe crypto comparison
          ├─► 2. Run increment_daily_token SQL function (atomic transaction)
          ├─► 3. Queue job state, dispatch Email/SMS notifications & FCM Alerts
          └─► 4. Return Print Token (e.g., "12-1") to Customer client
```

### 7.3 Local Agent Job Polling & Spooler Flow
```
   [Agent Daemon (agent.js)]
          │
          ▼
   [Queue Listener] ──► Polling /api/jobs or Firebase live listen
          │
          ▼
   [Job Filtering]
          │
          ├─► 1. Filter jobs by Shop ID & Status ("pending")
          ├─► 2. Check print channel: B&W or Color modes
          │
          ▼
   [Cooldown Assessment] ──► Has continuous printed pages exceeded limit (e.g. 80 pages)?
          ├─ Yes ──► Pause Queue, trigger Cooldown timer (5 mins), and alert console
          └─ No  ──► Continue
          │
          ▼
   [Local Journal Write] ──► Save state in local buffer "jobs_journal.json"
          │
          ▼
   [Print Executor]
          │
          ├─► Update Status: "printing"
          ├─► Download document file, convert/stamp page margins
          ├─► Call "pdf-to-printer" to execute OS print spooler
          │
          ▼
   [Completion Sync]
          │
          ├─► Print spooled successfully?
          │     ├─ Yes ──► Update Status: "completed"
          │     └─ No  ──► Update Status: "failed", write spooler error logs
          ▼
   [Cloud status update sync] ──► Post final telemetry back to the backend
```

---

## 📈 8. Printer Cooldown Safety Algorithm

To prevent physical hardware damage and overheating on local printers (which may be standard consumer-grade printers), the local print agent implements an automated cooldown system:

1.  **Tracker initialization**: The agent tracks `cumulativePageCount` on startup.
2.  **Job page inspection**: When a job is fetched, the agent parses the required sheets (`totalPages * copies`).
3.  **Cooldown verification**:
    *   If `cumulativePageCount + jobSheets` exceeds `maxPagesPerBatch` (default: 80 pages):
        *   The agent sets a local block flag.
        *   It updates the console with a **COOLDOWN ACTIVE** warning status.
        *   It schedules a recovery timeout based on the shop settings (`cooldownMin` - e.g. 5 minutes).
        *   The queue loop is paused, letting the physical printer cool down.
    *   Once the timeout completes:
        *   `cumulativePageCount` is reset to 0.
        *   The cooldown flag is cleared.
        *   The print queue resume polling daemon starts processing the pending queue again.
4.  **Mock Preview Override**: If `MOCK_PRINT_TO_FILE=true` is set, the agent bypasses physical printer calls and saves stamped PDF pages to `agent/mock_prints/` for development testing.
