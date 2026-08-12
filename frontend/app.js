// Firebase Client Configuration - PLACEHOLDERS
const firebaseConfig = {
  apiKey: "YOUR_API_KEY_HERE",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Global App State
let uploadedFiles = [];
let printType = 'bw'; // 'bw' or 'color'
let copies = 1;
let firebaseInitialized = false;
let activeJobRef = null;
let bwRate = 2.00;
let colorRate = 10.00;
let layoutQueue = [];
let originalLayoutQueue = [];
function pushToQueue(item) {
  layoutQueue.push(item);
  originalLayoutQueue.push(item);
}

// Client limits, routing and identification
let maxPagesPerBatch = 80;
let cooldownMin = 5;
let recaptchaSiteKey = '';
let upiId = '';
const urlParams = new URLSearchParams(window.location.search);
const shopId = urlParams.get('shop') || 'default_shop';
let clientId = localStorage.getItem('kiosk_client_id');
if (!clientId) {
  clientId = 'client_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  localStorage.setItem('kiosk_client_id', clientId);
}

// Grid Layout state
let layoutPreset = '1'; // '1', '2', '4', '6', '8', 'custom'
let imagesPerPage = 1;
let isDemoMode = false;
let useSmartPacking = true;

// Initialize Firebase
try {
  if (firebaseConfig.apiKey && !firebaseConfig.apiKey.includes('YOUR_')) {
    firebase.initializeApp(firebaseConfig);
    firebaseInitialized = true;
    console.log("Firebase initialized successfully.");
  } else {
    console.warn("Firebase placeholders detected. Running in Demo/Mock storage mode.");
  }
} catch (error) {
  console.error("Error initializing Firebase:", error);
}

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const previewSection = document.getElementById('preview-section');
const previewGrid = document.getElementById('preview-grid');
const fileCountSpan = document.getElementById('file-count');
const btnGotoSettings = document.getElementById('btn-goto-settings');

const panelUpload = document.getElementById('panel-upload');
const panelSettings = document.getElementById('panel-settings');
const panelPrinting = document.getElementById('panel-printing');

const btnBackToUpload = document.getElementById('btn-back-to-upload');
const btnStartCheckout = document.getElementById('btn-start-checkout');

const labelBw = document.getElementById('label-bw');
const labelColor = document.getElementById('label-color');
const btnCopyDec = document.getElementById('btn-copy-dec');
const btnCopyInc = document.getElementById('btn-copy-inc');
const inputCopies = document.getElementById('input-copies');

// Custom Grid DOM Elements
const customGridControls = document.getElementById('custom-grid-controls');
const inputImgCount = document.getElementById('custom-images-count');
const btnImgDec = document.getElementById('btn-img-dec');
const btnImgInc = document.getElementById('btn-img-inc');
const spanGridInfo = document.getElementById('custom-grid-info');
const toggleSmartPacking = document.getElementById('toggle-smart-packing');
const toggleDemoMode = document.getElementById('toggle-demo-mode');
const packingModeCard = document.getElementById('packing-mode-card');

// Billing Details Elements
const billImages = document.getElementById('bill-images');
const billPages = document.getElementById('bill-pages'); // represents physical A4 paper sheets
const billCopies = document.getElementById('bill-copies');
const billRate = document.getElementById('bill-rate');
const billTotal = document.getElementById('bill-total');

// Printing Status / Receipt Elements
const processingView = document.getElementById('processing-view');
const receiptView = document.getElementById('receipt-view');
const processingProgress = document.getElementById('processing-progress');
const statusTitle = document.getElementById('status-title');
const statusDesc = document.getElementById('status-desc');

const receiptToken = document.getElementById('receipt-token');
const receiptTokenInstruction = document.getElementById('receipt-token-instruction');
const receiptJobId = document.getElementById('receipt-job-id');
const receiptJobStatus = document.getElementById('receipt-job-status');
const receiptJobPages = document.getElementById('receipt-job-pages');
const receiptJobCopies = document.getElementById('receipt-job-copies');
const receiptJobType = document.getElementById('receipt-job-type');
const receiptDate = document.getElementById('receipt-date');
const btnRestart = document.getElementById('btn-restart');

// API Server Endpoint (Change to production URL if hosted elsewhere)
const isLocalNetwork = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' || 
                       window.location.hostname.startsWith('192.168.') || 
                       window.location.hostname.startsWith('10.') || 
                       window.location.hostname.startsWith('172.');
const API_BASE_URL = 'https://action-uniprotkb-ecommerce-mechanism.trycloudflare.com';

// Step nodes for progress bar
const stepNode1 = document.getElementById('step-node-1');
const stepNode2 = document.getElementById('step-node-2');
const stepNode3 = document.getElementById('step-node-3');
const stepLine1 = document.getElementById('step-line-1');
const stepLine2 = document.getElementById('step-line-2');

// --- EVENT LISTENERS ---

// Drag and drop setup
dropZone.addEventListener('click', (e) => {
  if (e.target !== fileInput) {
    fileInput.click();
  }
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files) {
    handleFiles(e.dataTransfer.files);
  }
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files) {
    handleFiles(e.target.files);
  }
});

// Panel Navigation
btnGotoSettings.addEventListener('click', () => {
  let totalUploadedPages = 0;
  uploadedFiles.forEach(file => {
    totalUploadedPages += (file.pageCount || 1);
  });
  
  if (totalUploadedPages > maxPagesPerBatch) {
    alert(`Limit Exceeded: Total pages (${totalUploadedPages}) exceeds the maximum page limit allowed per printing batch (${maxPagesPerBatch} pages). Please remove some documents to fit the limit.`);
    return;
  }

  // Show page selection option if there are PDFs or document files uploaded
  const hasDocuments = uploadedFiles.some(f => {
    const name = f.name.toLowerCase();
    return name.endsWith('.pdf') || name.endsWith('.txt') || name.endsWith('.doc') || name.endsWith('.docx') || name.endsWith('.ppt') || name.endsWith('.pptx') || name.endsWith('.xls') || name.endsWith('.xlsx');
  });
  
  const pageSelectionCard = document.getElementById('page-selection-card');
  if (pageSelectionCard) {
    pageSelectionCard.style.display = hasDocuments ? 'block' : 'none';
  }

  navigateToPanel('settings');
});

function resetAll() {
  uploadedFiles = [];
  layoutQueue = [];
  originalLayoutQueue = [];
  copies = 1;
  inputCopies.value = 1;
  fileInput.value = '';
  previewGrid.innerHTML = '';
  previewSection.style.display = 'none';
  btnGotoSettings.disabled = true;
  resetGridSelectors();
  
  const sheetPreview = document.getElementById('sheets-preview-container');
  if (sheetPreview) sheetPreview.innerHTML = '';
  
  const layoutPreviewCard = document.getElementById('layout-preview-card');
  if (layoutPreviewCard) layoutPreviewCard.style.display = 'none';

  const rangeInput = document.getElementById('input-page-range');
  if (rangeInput) rangeInput.value = '';
  const rangeCard = document.getElementById('page-selection-card');
  if (rangeCard) rangeCard.style.display = 'none';
  
  billImages.innerText = '0';
  billPages.innerText = '0';
  billCopies.innerText = '1';
  billTotal.innerText = '₹0.00';
  
  navigateToPanel('upload');
}

btnBackToUpload.addEventListener('click', () => {
  navigateToPanel('upload');
});

btnStartCheckout.addEventListener('click', startPrintJobFlow);

btnRestart.addEventListener('click', resetAll);

// Setting Preferences Events
labelBw.addEventListener('click', () => {
  document.querySelectorAll('input[name="printType"]').forEach(r => r.checked = false);
  document.getElementById('label-bw').classList.add('active');
  document.getElementById('label-color').classList.remove('active');
  printType = 'bw';
  updateCostEstimation();
  updateLayoutPreview();
});

labelColor.addEventListener('click', () => {
  document.querySelectorAll('input[name="printType"]').forEach(r => r.checked = false);
  document.getElementById('label-color').classList.add('active');
  document.getElementById('label-bw').classList.remove('active');
  printType = 'color';
  updateCostEstimation();
  updateLayoutPreview();
});

btnCopyDec.addEventListener('click', () => {
  if (copies > 1) {
    copies--;
    inputCopies.value = copies;
    updateCostEstimation();
  }
});

btnCopyInc.addEventListener('click', () => {
  if (copies < 99) {
    copies++;
    inputCopies.value = copies;
    updateCostEstimation();
  }
});

// Grid Preset Layout Handlers
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    layoutPreset = btn.getAttribute('data-layout');
    
    if (layoutPreset === 'custom') {
      customGridControls.style.display = 'flex';
      imagesPerPage = parseInt(inputImgCount.value) || 5;
      spanGridInfo.innerText = imagesPerPage;
    } else {
      customGridControls.style.display = 'none';
      imagesPerPage = parseInt(layoutPreset);
    }
    
    // Show smart packing card if there's more than 1 image per page
    packingModeCard.style.display = imagesPerPage > 1 ? 'block' : 'none';
    
    updateCostEstimation();
  });
});

// Custom Images count control events
btnImgDec.addEventListener('click', () => {
  let val = parseInt(inputImgCount.value);
  if (val > 1) {
    val--;
    inputImgCount.value = val;
    imagesPerPage = val;
    spanGridInfo.innerText = val;
    packingModeCard.style.display = imagesPerPage > 1 ? 'block' : 'none';
    updateCostEstimation();
  }
});

btnImgInc.addEventListener('click', () => {
  let val = parseInt(inputImgCount.value);
  if (val < 16) {
    val++;
    inputImgCount.value = val;
    imagesPerPage = val;
    spanGridInfo.innerText = val;
    packingModeCard.style.display = imagesPerPage > 1 ? 'block' : 'none';
    updateCostEstimation();
  }
});

// Smart Packing & Demo Mode Toggles
toggleSmartPacking.addEventListener('change', () => {
  useSmartPacking = toggleSmartPacking.checked;
  updateLayoutPreview();
});

toggleDemoMode.addEventListener('change', () => {
  isDemoMode = toggleDemoMode.checked;
});


// --- HELPER FUNCTIONS ---

function resetGridSelectors() {
  document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.layout-btn[data-layout="1"]').classList.add('active');
  customGridControls.style.display = 'none';
  layoutPreset = '1';
  imagesPerPage = 1;
}

function getBestGridDimensions(n) {
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 2, cols: 1 };
  if (n === 3) return { rows: 3, cols: 1 };
  if (n === 4) return { rows: 2, cols: 2 };
  if (n === 5 || n === 6) return { rows: 3, cols: 2 };
  if (n === 7 || n === 8) return { rows: 4, cols: 2 };
  if (n === 9) return { rows: 3, cols: 3 };
  if (n === 10) return { rows: 5, cols: 2 };
  if (n <= 12) return { rows: 4, cols: 3 };
  return { rows: Math.ceil(n / 3), cols: 3 };
}

function navigateToPanel(panelName) {
  panelUpload.classList.remove('active');
  panelSettings.classList.remove('active');
  panelPrinting.classList.remove('active');

  stepNode1.classList.remove('active');
  stepNode2.classList.remove('active');
  stepNode3.classList.remove('active');
  stepLine1.classList.remove('active');
  stepLine2.classList.remove('active');

  if (panelName === 'upload') {
    panelUpload.classList.add('active');
    stepNode1.classList.add('active');
  } else if (panelName === 'settings') {
    panelSettings.classList.add('active');
    stepNode1.classList.add('active');
    stepLine1.classList.add('active');
    stepNode2.classList.add('active');
    updateCostEstimation();
  } else if (panelName === 'printing') {
    panelPrinting.classList.add('active');
    stepNode1.classList.add('active');
    stepLine1.classList.add('active');
    stepNode2.classList.add('active');
    stepLine2.classList.add('active');
    stepNode3.classList.add('active');
  }
}

// Helper for rendering PDF page thumbnails client-side
async function renderPdfThumbnails(file, itemIds) {
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const viewport = page.getViewport({ scale: 0.4 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      await page.render({ canvasContext: context, viewport: viewport }).promise;
      const dataUrl = canvas.toDataURL();
      const aspect = canvas.width / canvas.height;
      
      // Update matching layoutQueue items
      const targetId = itemIds[i];
      const item = layoutQueue.find(q => q.id === targetId);
      if (item) {
        item.previewUrl = dataUrl;
        item.aspectRatio = aspect;
      }
    }
    updateLayoutPreview();
  } catch (err) {
    console.error("Failed to render PDF thumbnails:", err);
  }
}

// File Upload Handler (PDF, TXT, DOC/DOCX, PPT/PPTX, XLS/XLSX, Images)
async function handleFiles(files) {
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.txt', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileNameLower = file.name.toLowerCase();
    const isAllowed = allowedExtensions.some(ext => fileNameLower.endsWith(ext));

    if (isAllowed) {
      if (!uploadedFiles.some(f => f.name === file.name && f.size === file.size)) {
        // Pre-parse the file page count asynchronously to show exact estimates
        file.pageCount = 1; // Default
        let bytes = null;
        let pageCount = 1;

        try {
          if (fileNameLower.endsWith('.pdf')) {
            bytes = await readFileAsArrayBuffer(file);
            const pdfDoc = await PDFLib.PDFDocument.load(bytes);
            pageCount = pdfDoc.getPageCount();
            file.pageCount = pageCount;
          } else if (fileNameLower.endsWith('.txt')) {
            const text = await file.text();
            file.pageCount = Math.ceil(text.split('\n').length / 55) || 1;
          }
        } catch (e) {
          console.error(`Failed to pre-parse pages for: ${file.name}`, e);
        }

        uploadedFiles.push(file);

        // Add to layoutQueue
        if (file.type.startsWith('image/')) {
          const previewUrl = URL.createObjectURL(file);
          file.preview = previewUrl;
          const imgItem = {
            id: `img_${Date.now()}_${Math.random()}`,
            type: 'image',
            file: file,
            name: file.name,
            previewUrl: previewUrl,
            aspectRatio: 0.707 // fallback
          };
          pushToQueue(imgItem);

          // Get exact aspect ratio asynchronously
          const imgLoader = new Image();
          imgLoader.src = previewUrl;
          imgLoader.onload = () => {
            imgItem.aspectRatio = imgLoader.naturalWidth / imgLoader.naturalHeight;
            updateLayoutPreview();
          };
        } else if (fileNameLower.endsWith('.pdf')) {
          const itemIds = [];
          for (let p = 0; p < pageCount; p++) {
            const id = `pdf_${p}_${Date.now()}_${Math.random()}`;
            itemIds.push(id);
            pushToQueue({
              id: id,
              type: 'pdf_page',
              file: file,
              fileBytes: bytes,
              name: file.name,
              pageIndex: p,
              previewUrl: null
            });
          }
          renderPdfThumbnails(file, itemIds);
        } else if (fileNameLower.endsWith('.txt')) {
          try {
            const text = await file.text();
            const paragraphLines = text.split('\n');
            const maxChars = 40;
            const allWrappedLines = [];
            paragraphLines.forEach(para => {
              const wrapped = wrapText(para, maxChars);
              allWrappedLines.push(...wrapped);
            });
            const maxLines = 15;
            const textPageCount = Math.ceil(allWrappedLines.length / maxLines) || 1;
            file.pageCount = textPageCount;

            for (let p = 0; p < textPageCount; p++) {
              const chunkLines = allWrappedLines.slice(p * maxLines, (p + 1) * maxLines);
              pushToQueue({
                id: `txt_${p}_${Date.now()}_${Math.random()}`,
                type: 'text_page',
                file: file,
                name: file.name,
                lines: chunkLines,
                pageIndex: p
              });
            }
          } catch (e) {}
        } else {
          pushToQueue({
            id: `office_${Date.now()}_${Math.random()}`,
            type: 'office_page',
            file: file,
            name: file.name
          });
        }
      }
    } else {
      alert(`File "${file.name}" format is not supported. Please upload Images, PDFs, TXT files, or Office Documents.`);
    }
  }

  updateFilePreviews();
}

function updateFilePreviews() {
  previewGrid.innerHTML = '';
  fileCountSpan.innerText = uploadedFiles.length;

  if (uploadedFiles.length > 0) {
    previewSection.style.display = 'block';
    btnGotoSettings.disabled = false;

    uploadedFiles.forEach((file, index) => {
      const previewItem = document.createElement('div');
      previewItem.classList.add('preview-item');

      const removeBtn = document.createElement('button');
      removeBtn.classList.add('remove-btn');
      removeBtn.innerHTML = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFile(index);
      });

      const indexLabel = document.createElement('span');
      indexLabel.classList.add('file-index');
      indexLabel.innerText = `File ${index + 1}`;

      const fileNameLower = file.name.toLowerCase();

      if (file.type.startsWith('image/')) {
        // Render Image Preview
        const img = document.createElement('img');
        const reader = new FileReader();
        reader.onload = function(e) {
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
        previewItem.appendChild(img);
      } else {
        // Render Document Placeholders with corresponding icons
        const placeholder = document.createElement('div');
        placeholder.style.display = 'flex';
        placeholder.style.flexDirection = 'column';
        placeholder.style.justifyContent = 'center';
        placeholder.style.alignItems = 'center';
        placeholder.style.height = '100%';
        placeholder.style.width = '100%';
        placeholder.style.padding = '8px';
        placeholder.style.textAlign = 'center';
        placeholder.style.background = '#f8fafc';
        
        let icon = '📄';
        let label = 'PDF';
        let color = '#3d5e35';
        
        if (fileNameLower.endsWith('.pdf')) {
          icon = '📄';
          label = `PDF (${file.pageCount}p)`;
          color = '#dc2626';
        } else if (fileNameLower.endsWith('.txt')) {
          icon = '📝';
          label = `TXT (${file.pageCount}p)`;
          color = '#475569';
        } else if (fileNameLower.endsWith('.doc') || fileNameLower.endsWith('.docx')) {
          icon = '📘';
          label = 'Word';
          color = '#2563eb';
        } else if (fileNameLower.endsWith('.ppt') || fileNameLower.endsWith('.pptx')) {
          icon = '📙';
          label = 'Slides';
          color = '#ea580c';
        } else if (fileNameLower.endsWith('.xls') || fileNameLower.endsWith('.xlsx')) {
          icon = '📊';
          label = 'Excel';
          color = '#16a34a';
        }

        placeholder.innerHTML = `
          <div style="font-size: 2rem; margin-bottom: 2px;">${icon}</div>
          <div style="font-size: 0.65rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; color: #334155;">${file.name}</div>
          <div style="font-size: 0.58rem; background: ${color}; color: white; padding: 2px 6px; border-radius: 4px; font-weight: 800; margin-top: 4px;">${label}</div>
        `;
        previewItem.appendChild(placeholder);
      }

      previewItem.appendChild(removeBtn);
      previewItem.appendChild(indexLabel);
      previewGrid.appendChild(previewItem);
    });
  } else {
    previewSection.style.display = 'none';
    btnGotoSettings.disabled = true;
  }
}

function removeFile(index) {
  const fileToRemove = uploadedFiles[index];
  uploadedFiles.splice(index, 1);
  
  // Filter layout queues
  layoutQueue = layoutQueue.filter(item => item.file.name !== fileToRemove.name || item.file.size !== fileToRemove.size);
  originalLayoutQueue = originalLayoutQueue.filter(item => item.file.name !== fileToRemove.name || item.file.size !== fileToRemove.size);
  
  updateFilePreviews();
  updateCostEstimation();
}

function parsePageRange(rangeStr, maxPages) {
  if (!rangeStr || rangeStr.trim() === '') {
    return Array.from({ length: maxPages }, (_, i) => i);
  }

  const pages = new Set();
  const parts = rangeStr.split(',');
  
  for (let part of parts) {
    part = part.trim();
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr.trim());
      const end = parseInt(endStr.trim());
      if (!isNaN(start) && !isNaN(end)) {
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        for (let p = low; p <= high; p++) {
          if (p >= 1 && p <= maxPages) {
            pages.add(p - 1);
          }
        }
      }
    } else {
      const p = parseInt(part);
      if (!isNaN(p) && p >= 1 && p <= maxPages) {
        pages.add(p - 1);
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

function applyPageSelectionFilter() {
  const rangeInput = document.getElementById('input-page-range');
  if (!rangeInput) return;
  const rangeStr = rangeInput.value.trim();
  
  if (rangeStr === '') {
    layoutQueue = [...originalLayoutQueue];
    return;
  }
  
  const allowedIndices = parsePageRange(rangeStr, originalLayoutQueue.length);
  layoutQueue = originalLayoutQueue.filter((_, idx) => allowedIndices.includes(idx));
}

// Bind page range input change listener
const rangeInputEl = document.getElementById('input-page-range');
if (rangeInputEl) {
  rangeInputEl.addEventListener('input', () => {
    applyPageSelectionFilter();
    updateCostEstimation();
  });
}

// Bind paper size selector change listener
const paperSizeSelectEl = document.getElementById('select-paper-size');
if (paperSizeSelectEl) {
  paperSizeSelectEl.addEventListener('change', () => {
    updateLayoutPreview();
    updateCostEstimation();
  });
}

function calculateSheetsCount() {
  const totalPages = layoutQueue.length;
  if (totalPages === 0) return 0;
  return Math.ceil(totalPages / imagesPerPage);
}

function updateCostEstimation() {
  const rate = printType === 'bw' ? bwRate : colorRate;
  const sheets = calculateSheetsCount();
  const total = rate * sheets * copies;

  billImages.innerText = uploadedFiles.length;
  billPages.innerText = sheets;
  billCopies.innerText = copies;
  billRate.innerText = `₹${rate.toFixed(2)}`;
  billTotal.innerText = `₹${total.toFixed(2)}`;

  // Update layout preview grid
  updateLayoutPreview();
}

// Global Move Item Handler (Moves pages left or right in the printable queue)
window.moveQueueItem = function(idx, direction) {
  if (idx < 0 || idx >= layoutQueue.length) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= layoutQueue.length) return;

  const temp = layoutQueue[idx];
  layoutQueue[idx] = layoutQueue[targetIdx];
  layoutQueue[targetIdx] = temp;

  updateCostEstimation();
};

function updateLayoutPreview() {
  const container = document.getElementById('sheets-preview-container');
  const card = document.getElementById('layout-preview-card');
  
  if (!container || !card) return;
  
  container.innerHTML = '';
  
  if (layoutQueue.length === 0) {
    card.style.display = 'none';
    return;
  }
  
  card.style.display = 'block';
  
  const totalSheets = Math.ceil(layoutQueue.length / imagesPerPage);

  const paperSizeVal = document.getElementById('select-paper-size')?.value || 'A4';
  for (let s = 0; s < totalSheets; s++) {
    const sheetDiv = document.createElement('div');
    sheetDiv.className = 'a4-sheet-preview';
    if (paperSizeVal === 'Letter') {
      sheetDiv.style.aspectRatio = '1 / 1.294';
    } else if (paperSizeVal === 'Legal') {
      sheetDiv.style.aspectRatio = '1 / 1.647';
    } else {
      sheetDiv.style.aspectRatio = '1 / 1.414';
    }
    sheetDiv.style.cursor = 'zoom-in';

    // Click sheet to Zoom in Lightbox
    sheetDiv.addEventListener('click', (e) => {
      if (e.target.closest('.slot-controls')) return;
      openLightboxZoom(s);
    });

    // Sheet label
    const sheetLabel = document.createElement('div');
    sheetLabel.className = 'sheet-number-label';
    sheetLabel.innerText = `Sheet ${s + 1}`;
    sheetDiv.appendChild(sheetLabel);

    // Get current items for this sheet
    const sheetItems = layoutQueue.slice(s * imagesPerPage, (s + 1) * imagesPerPage);

    // Group items on this sheet by aspect ratio
    const landscapes = sheetItems.filter(item => (item.aspectRatio || 0.707) > 1.05);
    const portraits = sheetItems.filter(item => (item.aspectRatio || 0.707) <= 1.05);

    if (useSmartPacking && landscapes.length > 0 && portraits.length > 0) {
      sheetDiv.classList.add('smart-layout');

      // 1. Landscape Row
      const landRow = document.createElement('div');
      landRow.className = 'preview-row-landscape';
      landRow.style.gridTemplateColumns = `repeat(${landscapes.length}, 1fr)`;
      const landAspect = 1.767 / landscapes.length;
      landscapes.forEach((item) => {
        const itemIdx = layoutQueue.indexOf(item);
        const slotDiv = createPreviewSlot(item, itemIdx, landAspect);
        landRow.appendChild(slotDiv);
      });
      sheetDiv.appendChild(landRow);

      // 2. Portrait Row
      const portRow = document.createElement('div');
      portRow.className = 'preview-row-portrait';
      portRow.style.gridTemplateColumns = `repeat(${portraits.length}, 1fr)`;
      const portAspect = 1.178 / portraits.length;
      portraits.forEach((item) => {
        const itemIdx = layoutQueue.indexOf(item);
        const slotDiv = createPreviewSlot(item, itemIdx, portAspect);
        portRow.appendChild(slotDiv);
      });
      sheetDiv.appendChild(portRow);

    } else {
      // Homogeneous layout: use balanced grid dimensions
      sheetDiv.classList.remove('smart-layout');
      const { rows, cols } = getBestGridDimensions(imagesPerPage);
      sheetDiv.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      sheetDiv.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      const slotAspect = 0.707 * (rows / cols);

      for (let slot = 0; slot < rows * cols; slot++) {
        if (slot < sheetItems.length) {
          const item = sheetItems[slot];
          const itemIdx = s * imagesPerPage + slot;
          const slotDiv = createPreviewSlot(item, itemIdx, slotAspect);
          sheetDiv.appendChild(slotDiv);
        } else {
          // Empty slot with preview-slot styling to keep grid identical
          const slotDiv = document.createElement('div');
          slotDiv.className = 'preview-slot';
          const blank = document.createElement('div');
          blank.className = 'slot-placeholder';
          blank.style.color = '#cbd5e1';
          blank.innerText = '(Empty)';
          slotDiv.appendChild(blank);
          sheetDiv.appendChild(slotDiv);
        }
      }
    }

    container.appendChild(sheetDiv);
  }
}

// Helper to create a single preview slot
function createPreviewSlot(item, itemIdx, slotAspect = 0.707) {
  const slotDiv = document.createElement('div');
  slotDiv.className = 'preview-slot';

  // Slot control buttons (Shift arrangement)
  const controls = document.createElement('div');
  controls.className = 'slot-controls';
  
  if (itemIdx > 0) {
    controls.innerHTML += `<button type="button" class="control-btn" onclick="moveQueueItem(${itemIdx}, -1)">◀</button>`;
  }
  if (itemIdx < layoutQueue.length - 1) {
    controls.innerHTML += `<button type="button" class="control-btn" onclick="moveQueueItem(${itemIdx}, 1)">▶</button>`;
  }
  slotDiv.appendChild(controls);

  // Slot content display
  if (item.type === 'image' && item.previewUrl) {
    const img = document.createElement('img');
    img.src = item.previewUrl;
    if (printType === 'bw') {
      img.style.filter = 'grayscale(1)';
    }
    
    // Check orientation match and rotate if needed to maximize printable size
    const imgAspect = item.aspectRatio || 0.707;
    const needsRotation = (slotAspect > 1.05 && imgAspect < 0.95) || (slotAspect < 0.95 && imgAspect > 1.05);
    if (needsRotation) {
      img.style.transform = 'rotate(90deg)';
      img.style.transformOrigin = 'center';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
    }
    
    slotDiv.appendChild(img);
  } else if (item.type === 'pdf_page' && item.previewUrl) {
    const img = document.createElement('img');
    img.src = item.previewUrl;
    if (printType === 'bw') {
      img.style.filter = 'grayscale(1)';
    }
    
    const imgAspect = item.aspectRatio || 0.707;
    const needsRotation = (slotAspect > 1.05 && imgAspect < 0.95) || (slotAspect < 0.95 && imgAspect > 1.05);
    if (needsRotation) {
      img.style.transform = 'rotate(90deg)';
      img.style.transformOrigin = 'center';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
    }
    
    slotDiv.appendChild(img);
  } else if (item.type === 'text_page' && item.lines) {
    const txtDiv = document.createElement('div');
    txtDiv.className = 'slot-pre-text';
    txtDiv.innerText = item.lines.join('\n');
    slotDiv.appendChild(txtDiv);
  } else {
    const icon = item.type === 'pdf_page' ? '📄' : (item.type === 'text_page' ? '📝' : '📁');
    const placeholder = document.createElement('div');
    placeholder.className = 'slot-placeholder';
    placeholder.innerHTML = `<span style="font-size: 0.9rem; display: block; margin-bottom: 2px;">${icon}</span>${item.name.substring(0, 10)}...`;
    slotDiv.appendChild(placeholder);
  }

  return slotDiv;
}

// Lightbox Modal Zoom Handlers
function openLightboxZoom(sheetIdx) {
  const modal = document.getElementById('preview-modal');
  const modalBody = document.getElementById('modal-body');
  if (!modal || !modalBody) return;

  modalBody.innerHTML = '';
  
  const sheetDiv = document.createElement('div');
  sheetDiv.className = 'a4-sheet-preview';
  sheetDiv.style.width = '100%';
  sheetDiv.style.height = '100%';

  const sheetItems = layoutQueue.slice(sheetIdx * imagesPerPage, (sheetIdx + 1) * imagesPerPage);
  const landscapes = sheetItems.filter(item => (item.aspectRatio || 0.707) > 1.05);
  const portraits = sheetItems.filter(item => (item.aspectRatio || 0.707) <= 1.05);

  if (useSmartPacking && landscapes.length > 0 && portraits.length > 0) {
    sheetDiv.classList.add('smart-layout');

    const landRow = document.createElement('div');
    landRow.className = 'preview-row-landscape';
    landRow.style.gridTemplateColumns = `repeat(${landscapes.length}, 1fr)`;
    const landAspect = 1.767 / landscapes.length;
    landscapes.forEach((item) => {
      const slotDiv = createPreviewSlotZoom(item, landAspect);
      landRow.appendChild(slotDiv);
    });
    sheetDiv.appendChild(landRow);

    const portRow = document.createElement('div');
    portRow.className = 'preview-row-portrait';
    portRow.style.gridTemplateColumns = `repeat(${portraits.length}, 1fr)`;
    const portAspect = 1.178 / portraits.length;
    portraits.forEach((item) => {
      const slotDiv = createPreviewSlotZoom(item, portAspect);
      portRow.appendChild(slotDiv);
    });
    sheetDiv.appendChild(portRow);

  } else {
    sheetDiv.classList.remove('smart-layout');
    const { rows, cols } = getBestGridDimensions(imagesPerPage);
    sheetDiv.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    sheetDiv.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    const slotAspect = 0.707 * (rows / cols);

    for (let slot = 0; slot < rows * cols; slot++) {
      if (slot < sheetItems.length) {
        const item = sheetItems[slot];
        const slotDiv = createPreviewSlotZoom(item, slotAspect);
        sheetDiv.appendChild(slotDiv);
      } else {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'preview-slot';
        const blank = document.createElement('div');
        blank.className = 'slot-placeholder';
        blank.style.color = '#cbd5e1';
        blank.innerText = '(Empty)';
        slotDiv.appendChild(blank);
        sheetDiv.appendChild(slotDiv);
      }
    }
  }

  modalBody.appendChild(sheetDiv);
  modal.classList.add('active');
}

function createPreviewSlotZoom(item, slotAspect = 0.707) {
  const slotDiv = document.createElement('div');
  slotDiv.className = 'preview-slot';

  if (item.type === 'image' && item.previewUrl) {
    const img = document.createElement('img');
    img.src = item.previewUrl;
    if (printType === 'bw') {
      img.style.filter = 'grayscale(1)';
    }
    
    const imgAspect = item.aspectRatio || 0.707;
    const needsRotation = (slotAspect > 1.05 && imgAspect < 0.95) || (slotAspect < 0.95 && imgAspect > 1.05);
    if (needsRotation) {
      img.style.transform = 'rotate(90deg)';
      img.style.transformOrigin = 'center';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
    }
    
    slotDiv.appendChild(img);
  } else if (item.type === 'pdf_page' && item.previewUrl) {
    const img = document.createElement('img');
    img.src = item.previewUrl;
    if (printType === 'bw') {
      img.style.filter = 'grayscale(1)';
    }
    
    const imgAspect = item.aspectRatio || 0.707;
    const needsRotation = (slotAspect > 1.05 && imgAspect < 0.95) || (slotAspect < 0.95 && imgAspect > 1.05);
    if (needsRotation) {
      img.style.transform = 'rotate(90deg)';
      img.style.transformOrigin = 'center';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
    }
    
    slotDiv.appendChild(img);
  } else if (item.type === 'text_page' && item.lines) {
    const txtDiv = document.createElement('div');
    txtDiv.className = 'slot-pre-text';
    txtDiv.style.fontSize = '0.75rem';
    txtDiv.innerText = item.lines.join('\n');
    slotDiv.appendChild(txtDiv);
  } else {
    const icon = item.type === 'pdf_page' ? '📄' : (item.type === 'text_page' ? '📝' : '📁');
    const placeholder = document.createElement('div');
    placeholder.className = 'slot-placeholder';
    placeholder.innerHTML = `<span style="font-size: 1.2rem; display: block; margin-bottom: 2px;">${icon}</span>${item.name}`;
    slotDiv.appendChild(placeholder);
  }
  return slotDiv;
}

// Attach lightbox close listeners
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('preview-modal');
  const closeBtn = document.getElementById('modal-close');
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
  }
});

async function loadKioskSettings() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/settings?shopId=${shopId}`);
    const data = await response.json();
    
    const configOverlay = document.getElementById('kiosk-config-overlay');
    if (data.bwPrice === null || data.colorPrice === null || data.bwPrice === undefined || data.colorPrice === undefined) {
      if (configOverlay) configOverlay.style.display = 'flex';
      return;
    }
    
    if (configOverlay) configOverlay.style.display = 'none';
    
    bwRate = parseFloat(data.bwPrice);
    colorRate = parseFloat(data.colorPrice);
    maxPagesPerBatch = data.maxPagesPerBatch ?? 80;
    cooldownMin = data.cooldownMin ?? 5;
    upiId = data.upiId || '';
    
    // Dynamically inject reCAPTCHA v3 script if configuration key exists
    if (data.recaptchaSiteKey && data.recaptchaSiteKey !== 'captcha_site_placeholder' && !recaptchaSiteKey) {
      recaptchaSiteKey = data.recaptchaSiteKey;
      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?render=${recaptchaSiteKey}`;
      document.head.appendChild(script);
    }
    
    const bwSubtitle = document.querySelector('#label-bw .subtitle');
    const colorSubtitle = document.querySelector('#label-color .subtitle');
    if (bwSubtitle) bwSubtitle.innerText = `₹${bwRate.toFixed(2)} / sheet`;
    if (colorSubtitle) colorSubtitle.innerText = `₹${colorRate.toFixed(2)} / sheet`;
    
    updateCostEstimation();

    // Check printer health and display warning banner if needed
    const printers = Object.values(data.printers || {});
    let hasAlert = false;
    let alertText = '';

    if (printers.length > 0) {
      const allOffline = printers.every(p => p.status === 'offline');
      const allPaperOut = printers.every(p => p.status === 'paper-out');

      if (allOffline) {
        hasAlert = true;
        alertText = '⚠️ Attention: All kiosk printers are currently offline. You can still queue your job, but printing will resume only after the operator re-connects.';
      } else if (allPaperOut) {
        hasAlert = true;
        alertText = '⚠️ Attention: Kiosk printers are currently out of paper. You can queue your job, but prints will be spooled after paper is re-filled.';
      } else {
        const offlinePrinters = printers.filter(p => p.status === 'offline');
        const paperOutPrinters = printers.filter(p => p.status === 'paper-out');
        const inkLowPrinters = printers.filter(p => p.status === 'ink-low');

        if (offlinePrinters.length > 0 || paperOutPrinters.length > 0 || inkLowPrinters.length > 0) {
          const warnings = [];
          if (offlinePrinters.length > 0) warnings.push(`${offlinePrinters.length} printer(s) offline`);
          if (paperOutPrinters.length > 0) warnings.push(`${paperOutPrinters.length} printer(s) out of paper`);
          if (inkLowPrinters.length > 0) warnings.push(`${inkLowPrinters.length} printer(s) low on ink`);
          hasAlert = true;
          alertText = `⚠️ Warning: Kiosk status is limited (${warnings.join(', ')}). Your print job may experience slight delays.`;
        }
      }
    }

    const warningBanner = document.getElementById('printer-status-banner');
    if (warningBanner) {
      if (hasAlert) {
        warningBanner.innerText = alertText;
        warningBanner.style.display = 'block';
      } else {
        warningBanner.style.display = 'none';
      }
    }
  } catch (err) {
    console.warn("Failed to load dynamic settings:", err);
  }
}
loadKioskSettings();
// Sync prices in real-time with admin dashboard price updates
setInterval(loadKioskSettings, 3000);

// Helper to wrap FileReader in Promise
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// Helper for splitting paragraphs into line arrays
function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxChars) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// --- PDF COMPILATION & SUBMISSION FLOW ---

async function startPrintJobFlow() {
  navigateToPanel('printing');
  processingView.style.display = 'flex';
  receiptView.style.display = 'none';
  updateProgress(10, "Compiling PDF", "Scaling and positioning multiple page templates...");

  try {
    const sheets = calculateSheetsCount();
    const customerContact = document.getElementById('input-customer-contact').value.trim();
    
    // Obtain Google reCAPTCHA token if active
    let captchaToken = '';
    if (recaptchaSiteKey) {
      try {
        captchaToken = await grecaptcha.execute(recaptchaSiteKey, { action: 'checkout' });
      } catch (err) {
        console.warn("Failed to generate Google CAPTCHA token:", err.message);
      }
    }
    
    // 1. Compile all multi-format uploads to A4 PDF using the layout engine
    const pdfBlob = await compileFilesToPDF();
    updateProgress(45, "Uploading Document", "Uploading your PDF safely to our kiosk storage...");

    // 2. Upload to Firebase Storage or use mock
    let fileUrl = '';
    if (firebaseInitialized) {
      const storageRef = firebase.storage().ref();
      const fileName = `kiosk_prints/print_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
      const fileRef = storageRef.child(fileName);
      
      const uploadMetadata = { contentType: 'application/pdf' };
      const uploadTask = await fileRef.put(pdfBlob, uploadMetadata);
      fileUrl = await uploadTask.ref.getDownloadURL();
      console.log("PDF successfully uploaded to Firebase. URL:", fileUrl);
    } else {
      // Upload raw PDF data to local mock storage server
      try {
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(pdfBlob);
          reader.onloadend = () => {
            resolve(reader.result.split(',')[1]);
          };
          reader.onerror = reject;
        });

        const uploadResp = await fetch(`${API_BASE_URL}/api/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: `local_print_${Date.now()}.pdf`, fileData: base64Data })
        });
        const uploadResult = await uploadResp.json();
        if (!uploadResp.ok) throw new Error(uploadResult.error || "Local upload failed");
        
        fileUrl = uploadResult.fileUrl;
        console.log("Mock Mode: Uploaded PDF to local server:", fileUrl);
      } catch (err) {
        console.error("Local mock storage upload failed, falling back:", err);
        fileUrl = `https://firebasestorage.googleapis.com/v0/b/mock-kiosk-bucket/o/kiosk_prints%2Fmock_print_${Date.now()}.pdf?alt=media`;
      }
    }

    if (isDemoMode) {
      // Direct local sandbox bypass: Skip order creation and Razorpay completely!
      console.warn("Demo Mode: Bypassing payment process.");
      updateProgress(85, "Processing Print Job", "Queueing print job in demo sandbox...");
      
      const checkoutPayload = {
        fileUrl: fileUrl,
        printType: printType,
        totalPages: sheets,
        copies: copies,
        clientId: clientId,
        customerContact: customerContact,
        shopId: shopId,
        paperSize: document.getElementById('select-paper-size')?.value || 'A4',
        status: 'pending_payment'
      };

      const response = await fetch(`${API_BASE_URL}/api/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(checkoutPayload)
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed demo checkout.");
      }

      updateProgress(100, "Done", "Print job successfully scheduled.");
      showReceipt(result, sheets);
      return; // end flow
    }

    updateProgress(70, "Initiating Payment", "Creating secure payment transaction...");

    // 3. Create payment order on the backend
    const orderResponse = await fetch(`${API_BASE_URL}/api/payment/order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        printType: printType,
        totalPages: sheets,
        copies: copies,
        clientId: clientId,
        captchaToken: captchaToken,
        shopId: shopId
      })
    });

    const orderData = await orderResponse.json();
    if (!orderResponse.ok) {
      throw new Error(orderData.error || orderData.message || "Failed to create payment order.");
    }

    // 4. Open Razorpay payment gateway
    // 4. Open Payment Gateway (Simulated Modal if no Razorpay keys are set)
    if (orderData.mockOrder) {
      // Define simulated Razorpay SDK globally
      window.Razorpay = class MockRazorpay {
        constructor(options) {
          this.options = options;
        }

        open() {
          const modalOverlay = document.createElement('div');
          modalOverlay.id = 'mock-razorpay-overlay';
          modalOverlay.style.position = 'fixed';
          modalOverlay.style.top = '0';
          modalOverlay.style.left = '0';
          modalOverlay.style.width = '100%';
          modalOverlay.style.height = '100%';
          modalOverlay.style.background = 'rgba(15, 23, 42, 0.65)';
          modalOverlay.style.backdropFilter = 'blur(4px)';
          modalOverlay.style.zIndex = '99999';
          modalOverlay.style.display = 'flex';
          modalOverlay.style.alignItems = 'center';
          modalOverlay.style.justifyContent = 'center';
          modalOverlay.style.padding = '20px';

          const container = document.createElement('div');
          container.style.background = '#ffffff';
          container.style.width = '100%';
          container.style.maxWidth = '380px';
          container.style.borderRadius = '12px';
          container.style.boxShadow = '0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.04)';
          container.style.overflow = 'hidden';
          container.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
          container.style.border = '1px solid #e2e8f0';

          // Header
          const header = document.createElement('div');
          header.style.background = this.options.theme?.color || '#3d5e35';
          header.style.padding = '24px 20px';
          header.style.color = '#ffffff';
          header.style.position = 'relative';

          // Close button
          const closeBtn = document.createElement('button');
          closeBtn.innerHTML = '&#x2715;';
          closeBtn.style.position = 'absolute';
          closeBtn.style.top = '16px';
          closeBtn.style.right = '16px';
          closeBtn.style.background = 'none';
          closeBtn.style.border = 'none';
          closeBtn.style.color = 'rgba(255, 255, 255, 0.8)';
          closeBtn.style.fontSize = '18px';
          closeBtn.style.cursor = 'pointer';
          closeBtn.onclick = () => {
            modalOverlay.remove();
            if (this.options.modal?.ondismiss) {
              this.options.modal.ondismiss();
            }
          };

          const merchantName = document.createElement('h3');
          merchantName.innerText = this.options.name || 'InstaPrint Kiosk';
          merchantName.style.fontSize = '16px';
          merchantName.style.fontWeight = '600';
          merchantName.style.marginBottom = '4px';

          const desc = document.createElement('p');
          desc.innerText = this.options.description || '';
          desc.style.fontSize = '12px';
          desc.style.color = 'rgba(255, 255, 255, 0.8)';
          desc.style.marginBottom = '12px';

          const amountContainer = document.createElement('div');
          amountContainer.style.fontSize = '22px';
          amountContainer.style.fontWeight = '700';
          amountContainer.innerText = `₹${(this.options.amount / 100).toFixed(2)}`;

          header.appendChild(closeBtn);
          header.appendChild(merchantName);
          header.appendChild(desc);
          header.appendChild(amountContainer);
          container.appendChild(header);

          // Content body
          const body = document.createElement('div');
          body.style.padding = '20px';

          // Sandbox Banner
          const banner = document.createElement('div');
          banner.style.background = '#fff3cd';
          banner.style.border = '1px solid #ffeeba';
          banner.style.color = '#856404';
          banner.style.padding = '8px 12px';
          banner.style.borderRadius = '6px';
          banner.style.fontSize = '11px';
          banner.style.marginBottom = '16px';
          banner.style.textAlign = 'center';
          banner.innerText = '⚠️ Razorpay Sandbox / Test Mode';
          body.appendChild(banner);

          // List of simulated payment options
          const optionsList = document.createElement('div');
          optionsList.style.display = 'flex';
          optionsList.style.flexDirection = 'column';
          optionsList.style.gap = '10px';

          const paymentMethods = [
            { id: 'card', name: 'Card', desc: 'Visa, Mastercard, RuPay', icon: '💳' },
            { id: 'upi', name: 'UPI', desc: 'Google Pay, PhonePe, Paytm', icon: '📱' },
            { id: 'netbanking', name: 'Netbanking', desc: 'All Indian banks', icon: '🏦' },
            { id: 'wallet', name: 'Wallet', desc: 'Mobikwik, Freecharge', icon: '👛' }
          ];

          paymentMethods.forEach(method => {
            const btn = document.createElement('button');
            btn.style.width = '100%';
            btn.style.padding = '12px 16px';
            btn.style.background = '#f8fafc';
            btn.style.border = '1px solid #e2e8f0';
            btn.style.borderRadius = '8px';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.gap = '12px';
            btn.style.cursor = 'pointer';
            btn.style.textAlign = 'left';
            btn.style.transition = 'all 0.2s';
            btn.onmouseover = () => {
              btn.style.background = '#f1f5f9';
              btn.style.borderColor = '#cbd5e1';
            };
            btn.onmouseout = () => {
              btn.style.background = '#f8fafc';
              btn.style.borderColor = '#e2e8f0';
            };

            const iconSpan = document.createElement('span');
            iconSpan.innerHTML = method.icon;
            iconSpan.style.fontSize = '20px';

            const infoDiv = document.createElement('div');
            const nameP = document.createElement('p');
            nameP.innerText = method.name;
            nameP.style.fontSize = '14px';
            nameP.style.fontWeight = '600';
            nameP.style.color = '#0f172a';

            const descP = document.createElement('p');
            descP.innerText = method.desc;
            descP.style.fontSize = '11px';
            descP.style.color = '#64748b';

            infoDiv.appendChild(nameP);
            infoDiv.appendChild(descP);
            btn.appendChild(iconSpan);
            btn.appendChild(infoDiv);

            btn.onclick = () => {
              simulatePaymentFlow(method.id);
            };

            optionsList.appendChild(btn);
          });

          body.appendChild(optionsList);

          // Footer
          const footer = document.createElement('div');
          footer.style.marginTop = '20px';
          footer.style.textAlign = 'center';
          footer.style.fontSize = '10px';
          footer.style.color = '#94a3b8';
          footer.innerText = '🔒 Secured by Razorpay Mock Sandbox';
          body.appendChild(footer);

          container.appendChild(body);
          modalOverlay.appendChild(container);
          document.body.appendChild(modalOverlay);

          const simulatePaymentFlow = (method) => {
            body.innerHTML = `
              <div style="text-align: center; padding: 30px 10px;">
                <div style="border: 4px solid #f3f3f3; border-top: 4px solid ${this.options.theme?.color || '#3d5e35'}; border-radius: 50%; width: 40px; height: 40px; animation: rzp-spin 1s linear infinite; margin: 0 auto 16px auto;"></div>
                <h4 style="font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 4px;">Processing simulated ${method.toUpperCase()} payment...</h4>
                <p style="font-size: 12px; color: #64748b;">Do not close this window or refresh the page.</p>
              </div>
              <style>
                @keyframes rzp-spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              </style>
            `;

            setTimeout(() => {
              modalOverlay.remove();
              const mockPaymentId = 'pay_mock_' + Math.random().toString(36).substr(2, 9);
              const mockSignature = 'sig_mock_' + Math.random().toString(36).substr(2, 9);
              this.options.handler({
                razorpay_payment_id: mockPaymentId,
                razorpay_signature: mockSignature,
                razorpay_payment_method: method
              });
            }, 1500);
          };
        }
      };
    }

    updateProgress(80, "Awaiting Payment", "Please complete payment in the popup...");

    const options = {
      key: orderData.keyId,
      amount: orderData.amount,
      currency: orderData.currency,
      name: 'InstaPrint Kiosk',
      description: `Print service for ${sheets} sheets`,
      order_id: orderData.orderId,
      handler: async function (response) {
        try {
          updateProgress(90, "Verifying Payment", "Confirming secure transaction details...");

          const checkoutPayload = {
            fileUrl: fileUrl,
            printType: printType,
            totalPages: sheets,
            copies: copies,
            clientId: clientId,
            customerContact: customerContact,
            shopId: shopId,
            payment: {
              orderId: orderData.orderId,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              method: response.razorpay_payment_method || 'razorpay'
            },
            paperSize: document.getElementById('select-paper-size')?.value || 'A4'
          };
          const checkoutResp = await fetch(`${API_BASE_URL}/api/checkout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(checkoutPayload)
          });

          const result = await checkoutResp.json();
          if (!checkoutResp.ok) {
            throw new Error(result.error || result.message || "Payment verification failed.");
          }

          updateProgress(100, "Done", "Print job successfully scheduled.");
          showReceipt(result, sheets);
        } catch (err) {
          console.error("Payment confirmation failed:", err);
          alert(`Error confirming payment: ${err.message}`);
          navigateToPanel('settings');
        }
      },
      prefill: {
        name: 'Kiosk User',
        email: customerContact || 'user@kiosk.com',
        contact: '9999999999'
      },
      theme: {
        color: '#3d5e35'
      },
      modal: {
        ondismiss: function () {
          alert("Payment cancelled. The print job has not been scheduled.");
          navigateToPanel('settings');
        }
      }
    };

    const rzp = new Razorpay(options);
    rzp.open();

  } catch (error) {
    console.error("Print Job Flow failed:", error);
    alert(`Error: ${error.message || "Something went wrong during document preparation. Please try again."}`);
    navigateToPanel('settings');
  }
}

// Generalized dynamic grid multi-format compiler engine
async function compileFilesToPDF() {
  const paperSizeSelect = document.getElementById('select-paper-size');
  const paperSizeVal = paperSizeSelect ? paperSizeSelect.value : 'A4';
  
  let pageWidth = 595.28;
  let pageHeight = 841.89;
  
  if (paperSizeVal === 'Letter') {
    pageWidth = 612.00;
    pageHeight = 792.00;
  } else if (paperSizeVal === 'Legal') {
    pageWidth = 612.00;
    pageHeight = 1008.00;
  }
  
  const A4_WIDTH = pageWidth;
  const A4_HEIGHT = pageHeight;
  const SAFE_MARGIN = 40.0;
  
  const PRINTABLE_WIDTH = A4_WIDTH - (SAFE_MARGIN * 2);
  const PRINTABLE_HEIGHT = A4_HEIGHT - (SAFE_MARGIN * 2);

  const gap = 10.0;

  const pdfDoc = await PDFLib.PDFDocument.create();
  const fontCourier = await pdfDoc.embedFont(PDFLib.StandardFonts.Courier);

  // Helper to draw a single layout item in its calculated slot
  async function drawItemInSlot(item, slotX, slotY, slotWidth, slotHeight, page) {
    const isSinglePage = (imagesPerPage === 1);
    
    // Override slot dimensions to cover full page if single page print
    if (isSinglePage) {
      slotX = 0;
      slotY = 0;
      slotWidth = A4_WIDTH;
      slotHeight = A4_HEIGHT;
    }

    if (item.type === 'image') {
      const imageBytes = await readFileAsArrayBuffer(item.file);
      let embeddedImage;
      if (item.file.type === 'image/png') {
        embeddedImage = await pdfDoc.embedPng(imageBytes);
      } else {
        embeddedImage = await pdfDoc.embedJpg(imageBytes);
      }

      const { width: w, height: h } = embeddedImage.scale(1);
      const imgAspect = w / h;
      const slotAspect = slotWidth / slotHeight;
      const needsRotation = (slotAspect > 1.05 && imgAspect < 0.95) || (slotAspect < 0.95 && imgAspect > 1.05);

      if (needsRotation) {
        const s = Math.min(slotWidth / h, slotHeight / w) * (isSinglePage ? 1.0 : 0.92);
        const sw = h * s;
        const sh = w * s;

        page.drawImage(embeddedImage, {
          x: slotX + (slotWidth - sw) / 2,
          y: slotY + (slotHeight - sh) / 2 + sh,
          width: sh,
          height: sw,
          rotate: PDFLib.degrees(-90)
        });
      } else {
        const s = Math.min(slotWidth / w, slotHeight / h) * (isSinglePage ? 1.0 : 0.92);
        const sw = w * s;
        const sh = h * s;

        page.drawImage(embeddedImage, {
          x: slotX + (slotWidth - sw) / 2,
          y: slotY + (slotHeight - sh) / 2,
          width: sw,
          height: sh
        });
      }
    } else if (item.type === 'pdf_page') {
      try {
        const tempDoc = await PDFLib.PDFDocument.load(item.fileBytes);
        const [embeddedPage] = await pdfDoc.embedPages([tempDoc.getPage(item.pageIndex)]);
        
        const { width: w, height: h } = embeddedPage;
        const imgAspect = w / h;
        const slotAspect = slotWidth / slotHeight;
        const needsRotation = (slotAspect > 1.05 && imgAspect < 0.95) || (slotAspect < 0.95 && imgAspect > 1.05);

        if (needsRotation) {
          const s = Math.min(slotWidth / h, slotHeight / w) * (isSinglePage ? 1.0 : 0.92);
          const sw = h * s;
          const sh = w * s;

          page.drawPage(embeddedPage, {
            x: slotX + (slotWidth - sw) / 2,
            y: slotY + (slotHeight - sh) / 2 + sh,
            width: sh,
            height: sw,
            rotate: PDFLib.degrees(-90)
          });
        } else {
          const s = Math.min(slotWidth / w, slotHeight / h) * (isSinglePage ? 1.0 : 0.92);
          const sw = w * s;
          const sh = h * s;

          page.drawPage(embeddedPage, {
            x: slotX + (slotWidth - sw) / 2,
            y: slotY + (slotHeight - sh) / 2,
            width: sw,
            height: sh
          });
        }
      } catch (pdfErr) {
        console.error("Failed to draw embedded PDF page:", pdfErr);
      }
    } else if (item.type === 'text_page') {
      const fontSize = Math.min(10, Math.floor(slotWidth / 20));
      const lineSpacing = fontSize + 2;
      const yStart = slotY + slotHeight - 10;
      item.lines.forEach((line, lineIndex) => {
        page.drawText(line, {
          x: slotX + 5,
          y: yStart - (lineIndex * lineSpacing),
          size: fontSize,
          font: fontCourier,
          color: PDFLib.rgb(0.12, 0.16, 0.23)
        });
      });
    } else if (item.type === 'office_placeholder') {
      page.drawRectangle({
        x: slotX,
        y: slotY,
        width: slotWidth,
        height: slotHeight,
        color: PDFLib.rgb(0.98, 0.98, 0.98),
        borderColor: PDFLib.rgb(0.85, 0.85, 0.8),
        borderWidth: 1
      });
      page.drawText("⚠️ Office Document", {
        x: slotX + 8,
        y: slotY + slotHeight - 20,
        size: Math.min(9, Math.floor(slotWidth / 15)),
        font: fontCourier,
        color: PDFLib.rgb(0.75, 0.4, 0.0)
      });
      page.drawText(item.fileName.substring(0, 16), {
        x: slotX + 8,
        y: slotY + slotHeight - 34,
        size: Math.min(8, Math.floor(slotWidth / 20)),
        font: fontCourier,
        color: PDFLib.rgb(0.15, 0.15, 0.15)
      });
    }
  }

  // Flatten all pages directly from the arranged layoutQueue items
  const pagesToPrint = layoutQueue.map(item => {
    if (item.type === 'image') {
      return { type: 'image', file: item.file };
    } else if (item.type === 'pdf_page') {
      return { type: 'pdf_page', fileBytes: item.fileBytes, pageIndex: item.pageIndex };
    } else if (item.type === 'text_page') {
      return { type: 'text_page', lines: item.lines };
    } else {
      return { type: 'office_placeholder', fileName: item.name };
    }
  });

  const totalSheets = Math.ceil(pagesToPrint.length / imagesPerPage);

  // Compile A4 pages using the same Aspect-Ratio Row Packer
  for (let s = 0; s < totalSheets; s++) {
    const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
    const sheetItems = pagesToPrint.slice(s * imagesPerPage, (s + 1) * imagesPerPage);

    // Group by aspect ratio
    const landscapes = [];
    const portraits = [];

    sheetItems.forEach((item, idx) => {
      const queueItem = layoutQueue[s * imagesPerPage + idx];
      const aspect = queueItem ? (queueItem.aspectRatio || 0.707) : 0.707;
      item.aspectRatio = aspect;
      if (aspect > 1.05) {
        landscapes.push(item);
      } else {
        portraits.push(item);
      }
    });

    if (useSmartPacking && landscapes.length > 0 && portraits.length > 0) {
      // Mixed packing layout: Landscape row on top, Portrait row on bottom
      const landscapeRowH = PRINTABLE_HEIGHT * 0.4;
      const portraitRowH = PRINTABLE_HEIGHT * 0.6;

      // Draw landscape row (top of printable area)
      const landCols = landscapes.length;
      const landSlotW = (PRINTABLE_WIDTH - (landCols - 1) * gap) / landCols;
      const landSlotH = landscapeRowH - gap;

      for (let i = 0; i < landCols; i++) {
        const item = landscapes[i];
        const slotX = SAFE_MARGIN + i * (landSlotW + gap);
        const slotY = SAFE_MARGIN + portraitRowH;
        await drawItemInSlot(item, slotX, slotY, landSlotW, landSlotH, page);
      }

      // Draw portrait row (bottom of printable area)
      const portCols = portraits.length;
      const portSlotW = (PRINTABLE_WIDTH - (portCols - 1) * gap) / portCols;
      const portSlotH = portraitRowH - gap;

      for (let i = 0; i < portCols; i++) {
        const item = portraits[i];
        const slotX = SAFE_MARGIN + i * (portSlotW + gap);
        const slotY = SAFE_MARGIN;
        await drawItemInSlot(item, slotX, slotY, portSlotW, portSlotH, page);
      }

    } else {
      // Homogeneous layout: Balanced Grid layout
      const { rows, cols } = getBestGridDimensions(imagesPerPage);
      const slotWidth = (PRINTABLE_WIDTH - (cols - 1) * gap) / cols;
      const slotHeight = (PRINTABLE_HEIGHT - (rows - 1) * gap) / rows;

      for (let k = 0; k < sheetItems.length; k++) {
        const item = sheetItems[k];
        const r = Math.floor(k / cols);
        const c = k % cols;
        const slotX = SAFE_MARGIN + c * (slotWidth + gap);
        const slotY = SAFE_MARGIN + (rows - 1 - r) * (slotHeight + gap);
        await drawItemInSlot(item, slotX, slotY, slotWidth, slotHeight, page);
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

function updateProgress(percentage, title, desc) {
  processingProgress.style.width = `${percentage}%`;
  statusTitle.innerText = title;
  statusDesc.innerText = desc;
}

function showReceipt(jobResult, sheets, isAwaitingPayment = false) {
  processingView.style.display = 'none';
  receiptView.style.display = 'block';

  // Toggle receipt banner styles dynamically
  const banner = document.querySelector('.success-banner');
  const bannerTitle = banner.querySelector('h2');
  const bannerDesc = banner.querySelector('p');
  
  if (isAwaitingPayment) {
    banner.style.background = '#fef3c7';
    banner.style.color = '#92400e';
    banner.querySelector('.success-icon').innerText = '⏳';
    banner.querySelector('.success-icon').style.background = '#f59e0b';
    bannerTitle.innerText = 'Verification Pending';
    bannerDesc.innerText = 'Please show your UPI payment success screen to the shopkeeper.';
  } else {
    banner.style.background = 'var(--primary-light)';
    banner.style.color = 'var(--primary-color)';
    banner.querySelector('.success-icon').innerText = '✓';
    banner.querySelector('.success-icon').style.background = 'var(--primary-color)';
    bannerTitle.innerText = 'Order Placed!';
    bannerDesc.innerText = 'Your job has been queued at the kiosk printing system.';
  }

  const today = new Date();
  receiptDate.innerText = today.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  receiptToken.innerText = jobResult.tokenNumber;
  receiptTokenInstruction.innerText = jobResult.tokenNumber;
  receiptJobId.innerText = jobResult.jobId || 'N/A';
  
  receiptJobPages.innerText = sheets;
  receiptJobCopies.innerText = copies;
  receiptJobType.innerText = printType === 'bw' ? 'Black & White' : 'Full Color';
  
  const etaEl = document.getElementById('receipt-job-eta');
  if (etaEl) {
    etaEl.innerText = jobResult.eta || '1 min';
  }

  // Start real-time monitoring of job status
  monitorJobStatus(jobResult.jobId, isAwaitingPayment);
}

function monitorJobStatus(jobId, isAwaitingPayment = false) {
  const badge = receiptJobStatus;
  
  if (firebaseInitialized && jobId && !jobId.includes('mock_')) {
    // Listen to Firebase RTDB for real-time status updates
    const jobRef = firebase.database().ref(`print_queue/${jobId}`);
    activeJobRef = jobRef;

    jobRef.on('value', (snapshot) => {
      const jobData = snapshot.val();
      if (jobData) {
        updateStatusUI(jobData.status);
      }
    });
  } else {
    if (isAwaitingPayment) {
      updateStatusUI('pending_payment');
      
      const pollInterval = setInterval(async () => {
        try {
          const resp = await fetch(`${API_BASE_URL}/api/jobs?shopId=${shopId}`);
          const jobs = await resp.json();
          const currentJob = jobs[jobId];
          if (currentJob) {
            if (currentJob.status !== 'pending_payment') {
              updateStatusUI(currentJob.status);
              if (currentJob.status === 'completed' || currentJob.status === 'failed') {
                clearInterval(pollInterval);
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }, 3000);
    } else {
      // Poll the backend API for job status updates in mock mode
      console.log("Mock Mode: Polling local mock backend for job status...");
      const pollInterval = setInterval(async () => {
        try {
          const resp = await fetch(`${API_BASE_URL}/api/jobs?shopId=${shopId}`);
          const jobs = await resp.json();
          const currentJob = jobs[jobId];
          if (currentJob) {
            updateStatusUI(currentJob.status);
            if (currentJob.status === 'completed' || currentJob.status === 'failed') {
              clearInterval(pollInterval);
            }
          }
        } catch (e) {
          // ignore
        }
      }, 2000);
    }
  }
}

function updateStatusUI(status) {
  const badge = receiptJobStatus;
  
  if (status === 'awaiting_payment' || status === 'pending_payment') {
    badge.innerText = 'awaiting confirmation';
  } else {
    badge.innerText = status;
  }
  
  badge.className = 'badge';

  if (status === 'awaiting_payment' || status === 'pending_payment') {
    badge.classList.add('badge-pending');
    badge.style.background = '#fef3c7';
    badge.style.color = '#92400e';
  } else if (status === 'pending') {
    badge.classList.add('badge-pending');
    badge.style.background = '#e0f2fe';
    badge.style.color = '#0369a1';
  } else if (status === 'printing') {
    badge.classList.add('badge-printing');
  } else if (status === 'completed') {
    badge.classList.add('badge-completed');
    if (activeJobRef) {
      activeJobRef.off();
      activeJobRef = null;
    }
  }
}
