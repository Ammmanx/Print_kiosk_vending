const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('=========================================');
console.log(' Starting InstaPrint Self-Service Kiosk...');
console.log('=========================================');

const cloudflaredPath = path.join(__dirname, 'cloudflared.exe');

function startTunnel(port) {
  return new Promise((resolve, reject) => {
    console.log(`Starting Cloudflare tunnel for port ${port}...`);
    const tunnel = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${port}`]);
    let urlFound = false;

    // Save logs to a temp file in case we need to debug
    const logStream = fs.createWriteStream(path.join(__dirname, `tunnel_${port}.log`));
    tunnel.stdout.pipe(logStream);
    tunnel.stderr.pipe(logStream);

    const checkLogs = () => {
      if (urlFound) return;
      const logFile = path.join(__dirname, `tunnel_${port}.log`);
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        const match = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          urlFound = true;
          console.log(`[OK] Port ${port} is now exposed at: ${match[0]}`);
          resolve({ url: match[0], process: tunnel });
          return;
        }
      }
      setTimeout(checkLogs, 1000);
    };

    setTimeout(checkLogs, 1000);

    tunnel.on('error', (err) => {
      console.error(`Failed to start tunnel on port ${port}:`, err);
      reject(err);
    });
  });
}

async function main() {
  try {
    // 1. Start tunnels
    const backendTunnel = await startTunnel(5002);
    const frontendTunnel = await startTunnel(8080);

    // 2. Update frontend/app.js
    console.log('Updating frontend configurations...');
    const appJsPath = path.join(__dirname, 'frontend', 'app.js');
    let appJsContent = fs.readFileSync(appJsPath, 'utf8');
    appJsContent = appJsContent.replace(
      /const API_BASE_URL = 'https:\/\/[a-z0-9-]+\.trycloudflare\.com';/,
      `const API_BASE_URL = '${backendTunnel.url}';`
    );
    fs.writeFileSync(appJsPath, appJsContent, 'utf8');
    console.log('[OK] frontend/app.js updated.');

    // 3. Update agent/.env and backend/.env
    console.log('Updating agent environment settings...');
    const agentEnvPath = path.join(__dirname, 'agent', '.env');
    let envContent = `FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json

BACKEND_API_URL=${backendTunnel.url}
PUBLIC_FRONTEND_URL=${frontendTunnel.url}
MOCK_PRINT_TO_FILE=true
`;
    fs.writeFileSync(agentEnvPath, envContent, 'utf8');
    console.log('[OK] agent/.env updated.');

    console.log('Updating backend environment settings...');
    const backendEnvPath = path.join(__dirname, 'backend', '.env');
    let backendEnvContent = `PORT=5002
FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret_here
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json
PUBLIC_FRONTEND_URL=${frontendTunnel.url}
`;
    fs.writeFileSync(backendEnvPath, backendEnvContent, 'utf8');
    console.log('[OK] backend/.env updated.');

    // 4. Start backend server
    console.log('Starting Backend Server...');
    const backend = spawn('node', ['dist/server.js'], { cwd: path.join(__dirname, 'backend'), stdio: 'inherit' });

    // 5. Start print agent
    console.log('Starting Print Agent...');
    const agent = spawn('node', ['agent.js'], { cwd: path.join(__dirname, 'agent'), stdio: 'inherit' });

    // 6. Start frontend HTTP server
    console.log('Starting Storefront HTTP Server...');
    const http = spawn('npx', ['http-server', '.', '-p', '8080', '-c-1', '--cors'], { cwd: path.join(__dirname, 'frontend'), shell: true });

    console.log('\n=========================================');
    console.log(` Kiosk storefront is live at:`);
    console.log(` ${frontendTunnel.url}/?shop=default_shop`);
    console.log('=========================================');

    // Open dashboard in default browser
    setTimeout(() => {
      console.log('Opening Shopkeeper Dashboard...');
      try {
        const startCmd = process.platform === 'win32' ? 'start' : 'open';
        const { exec } = require('child_process');
        exec(`${startCmd} http://localhost:3000`);
      } catch (e) {}
    }, 4000);

  } catch (error) {
    console.error('Error starting kiosk:', error);
  }
}

main();
