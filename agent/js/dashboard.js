// Helper functions for clipboard copy and image downloads
function copyTextToClipboard(text, targetEl) {
  navigator.clipboard.writeText(text).then(() => {
    const originalText = targetEl.innerText;
    targetEl.innerText = 'Copied!';
    targetEl.style.background = 'var(--success-color)';
    targetEl.style.color = '#ffffff';
    setTimeout(() => {
      targetEl.innerText = originalText;
      targetEl.style.background = '';
      targetEl.style.color = '';
    }, 2000);
  }).catch(err => {
    console.error('Could not copy text: ', err);
  });
}

function downloadImage(url, filename) {
  if (url.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else {
    fetch(url)
      .then(resp => resp.blob())
      .then(blob => {
        const a = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      })
      .catch(err => {
        console.error('Failed to download image:', err);
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.click();
      });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  let activeBwJobId = null;
  let activeColorJobId = null;
  let knownJobTokens = new Set();

  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  function showNotification(title, body) {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }

  // Check authentication status
  function checkAuthentication() {
    const auth = localStorage.getItem('dashboard_authenticated');
    const shopId = localStorage.getItem('dashboard_shop_id');
    if (auth !== 'true' || !shopId) {
      window.location.href = 'login.html';
    } else {
      const shopBadge = document.getElementById('status-badge-shop');
      if (shopBadge) {
        shopBadge.innerText = `Shop ID: ${shopId}`;
      }
    }
  }
  checkAuthentication();

  // Portal Tab switching logic
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const activePortal = tab.getAttribute('data-portal');
      document.querySelectorAll('.portal-panel').forEach(panel => {
        panel.classList.remove('active');
      });
      document.getElementById(`portal-${activePortal}`).classList.add('active');
    });
  });

  // Analytics date filtering logic
  let currentAnalyticsFrom = '';
  let currentAnalyticsTo = '';

  document.getElementById('btn-apply-analytics').addEventListener('click', async () => {
    const fromInput = document.getElementById('analytics-date-from').value;
    const toInput = document.getElementById('analytics-date-to').value;
    const errorEl = document.getElementById('analytics-error-message');

    errorEl.style.display = 'none';
    errorEl.innerText = '';

    if (!fromInput || !toInput) {
      errorEl.innerText = 'Please select both From and To dates.';
      errorEl.style.display = 'block';
      return;
    }

    if (new Date(fromInput) > new Date(toInput)) {
      errorEl.innerText = 'From date cannot be after To date.';
      errorEl.style.display = 'block';
      return;
    }

    currentAnalyticsFrom = fromInput;
    currentAnalyticsTo = toInput;
    loadDashboardData();
  });

  document.getElementById('btn-reset-analytics').addEventListener('click', () => {
    document.getElementById('analytics-date-from').value = '';
    document.getElementById('analytics-date-to').value = '';
    document.getElementById('analytics-error-message').style.display = 'none';
    currentAnalyticsFrom = '';
    currentAnalyticsTo = '';
    loadDashboardData();
  });

  // Logout Handler
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('dashboard_authenticated');
    localStorage.removeItem('dashboard_shop_id');
    localStorage.removeItem('dashboard_token');
    window.location.href = 'login.html';
  });

  // View QR Modal Handler
  document.getElementById('btn-view-qr').addEventListener('click', () => {
    const qrOverlay = document.getElementById('qr-view-overlay');
    if (qrOverlay) {
      const qrLink = document.getElementById('qr-link');
      const qrImg = document.getElementById('qr-container')?.querySelector('img')?.src || '';
      document.getElementById('qr-view-image').src = qrImg;
      document.getElementById('qr-view-url').innerText = qrLink ? qrLink.innerText : '';
      
      document.getElementById('btn-download-qr-view').onclick = () => {
        downloadImage(qrImg, `qr_${localStorage.getItem('dashboard_shop_id') || 'shop'}.png`);
      };
      document.getElementById('btn-copy-url-view').onclick = (e) => {
        copyTextToClipboard(qrLink ? qrLink.innerText : '', e.target);
      };

      qrOverlay.style.display = 'flex';
    }
  });

  document.getElementById('btn-close-qr-view').addEventListener('click', () => {
    document.getElementById('qr-view-overlay').style.display = 'none';
  });

  // PDF Preview Rendering Helper
  async function renderPDFPreview(url, containerEl) {
    if (!window.pdfjsLib) {
      containerEl.innerHTML = '<div class="viewer-empty"><span>⚠️</span>PDF Preview library unavailable.</div>';
      return;
    }

    try {
      containerEl.innerHTML = '<div class="viewer-empty"><span>⏳</span>Loading Preview...</div>';
      
      const proxyUrl = `/api/pdf-proxy?url=${encodeURIComponent(url)}`;
      const loadingTask = pdfjsLib.getDocument(proxyUrl);
      const pdf = await loadingTask.promise;
      
      containerEl.innerHTML = '';
      const totalPages = Math.min(pdf.numPages, 3);
      for (let pNum = 1; pNum <= totalPages; pNum++) {
        const page = await pdf.getPage(pNum);
        const viewport = page.getViewport({ scale: 0.6 });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        containerEl.appendChild(canvas);
        await page.render({ canvasContext: context, viewport: viewport }).promise;
      }
    } catch (err) {
      console.error("Failed to render ongoing PDF:", err);
      containerEl.innerHTML = '<div class="viewer-empty" style="color:var(--danger-color)"><span>⚠️</span>Preview failed to load.</div>';
    }
  }

  // Fetch and populate config details
  let currentFrontendUrl = '';
  let currentQrCode = '';

  async function loadDashboardData() {
    try {
      const response = await fetch('/api/config');
      const config = await response.json();

      currentFrontendUrl = config.frontendUrl || '';
      currentQrCode = config.qrCode || '';

      const priceOverlay = document.getElementById('price-setup-overlay');
      if (config.bwPrice === null || config.colorPrice === null || config.bwPrice === undefined || config.colorPrice === undefined) {
        if (priceOverlay) priceOverlay.style.display = 'flex';
      } else {
        if (priceOverlay) priceOverlay.style.display = 'none';
      }

      // Update Finance
      document.getElementById('revenue-val').innerText = `₹${(config.revenue || 0).toFixed(2)}`;
      document.getElementById('completed-jobs-val').innerText = config.ordersCount || 0;

      // Fetch and populate Analytics
      try {
        let analyticsUrl = '/api/analytics';
        if (currentAnalyticsFrom && currentAnalyticsTo) {
          analyticsUrl += `?from=${currentAnalyticsFrom}&to=${currentAnalyticsTo}`;
        }
        const analyticsResponse = await fetch(analyticsUrl);
        const analytics = await analyticsResponse.json();
        
        document.getElementById('analytics-avg-pages').innerText = analytics.averageSheets || 0;
        document.getElementById('analytics-ratio').innerText = `${analytics.ratios.bw} / ${analytics.ratios.color}`;
        
        let popularPaper = 'N/A';
        let maxCount = 0;
        for (const [size, count] of Object.entries(analytics.paperSizes || {})) {
          if (count > maxCount) {
            maxCount = count;
            popularPaper = size;
          }
        }
        document.getElementById('analytics-paper').innerText = popularPaper;

        let peakHour = 'N/A';
        let maxHourCount = 0;
        for (let h = 0; h < 24; h++) {
          const count = analytics.hourlyDistribution[h] || 0;
          if (count > maxHourCount) {
            maxHourCount = count;
            const ampm = h >= 12 ? 'PM' : 'AM';
            const displayHour = h % 12 === 0 ? 12 : h % 12;
            peakHour = `${displayHour} ${ampm}`;
          }
        }
        document.getElementById('analytics-peak').innerText = peakHour;

        // Render transaction table
        const transactionsTbody = document.getElementById('transactions-tbody');
        const transactionsEmpty = document.getElementById('transactions-empty-state');
        if (transactionsTbody) {
          transactionsTbody.innerHTML = '';
          const txs = analytics.transactions || [];
          if (txs.length === 0) {
            transactionsEmpty.style.display = 'block';
          } else {
            transactionsEmpty.style.display = 'none';
            txs.forEach(tx => {
              const tr = document.createElement('tr');
              tr.innerHTML = `
                <td style="padding: 10px 8px;">${tx.date}</td>
                <td style="padding: 10px 8px;">${tx.printType === 'bw' ? '🔳 B&W' : '🌈 Color'}</td>
                <td style="padding: 10px 8px;">${tx.pages}</td>
                <td style="padding: 10px 8px;">₹${(tx.cost || 0).toFixed(2)}</td>
              `;
              transactionsTbody.appendChild(tr);
            });
          }
        }
      } catch (analyticsErr) {
        console.warn('Failed to load analytics details:', analyticsErr.message);
      }

      // Set form prices and configurations (only if not focused to avoid cursor resetting)
      const activeEl = document.activeElement;
      const bwInput = document.getElementById('input-bw-price');
      const colorInput = document.getElementById('input-color-price');
      const upiInput = document.getElementById('input-upi-id');

      if (activeEl !== bwInput) bwInput.value = config.bwPrice !== null ? config.bwPrice : '';
      if (activeEl !== colorInput) colorInput.value = config.colorPrice !== null ? config.colorPrice : '';
      if (activeEl !== upiInput) upiInput.value = config.upiId || '';

      // Populate profile details
      const profileShopName = document.getElementById('profile-shop-name');
      if (profileShopName) profileShopName.value = config.shopName || '';
      const profileEmail = document.getElementById('profile-merchant-email');
      if (profileEmail) profileEmail.value = config.email || '';
      const profileShopId = document.getElementById('profile-shop-id');
      if (profileShopId) profileShopId.value = config.shopId || '';
      const profileStorefront = document.getElementById('profile-storefront-url');
      if (profileStorefront) profileStorefront.value = config.frontendUrl || '';

      // Display stored permanent QR code from database
      const qrContainer = document.getElementById('qr-container');
      const qrLink = document.getElementById('qr-link');
      const frontendUrl = config.frontendUrl || 'http://localhost:8080';
      if (qrContainer && qrLink) {
        if (config.qrCode) {
          qrContainer.innerHTML = `<img src="${config.qrCode}" alt="Storefront QR" style="width: 100%; height: 100%; object-fit: contain;">`;
        } else {
          qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=128x128&data=${encodeURIComponent(frontendUrl)}" alt="Storefront QR" style="width: 100%; height: 100%; object-fit: contain;">`;
        }
        qrLink.href = frontendUrl;
        qrLink.innerText = frontendUrl;
      }

      // Bind profile page QR download button click
      const downloadProfileBtn = document.getElementById('btn-download-qr-profile');
      if (downloadProfileBtn) {
        downloadProfileBtn.onclick = () => {
          const resolvedQr = config.qrCode || `https://api.qrserver.com/v1/create-qr-code/?size=128x128&data=${encodeURIComponent(frontendUrl)}`;
          downloadImage(resolvedQr, `qr_${config.shopId || 'shop'}.png`);
        };
      }

      // Update Shop ID badge
      const shopBadge = document.getElementById('status-badge-shop');
      if (shopBadge && config.shopId) {
        shopBadge.innerText = `Shop ID: ${config.shopId}`;
      }

      // Update printers table only if modified to prevent UI flicker
      const printersJson = JSON.stringify(config.printers || {});
      const printersTbody = document.getElementById('printers-list-tbody');
      if (printersTbody && printersTbody.getAttribute('data-state') !== printersJson) {
        printersTbody.setAttribute('data-state', printersJson);
        printersTbody.innerHTML = '';
        
        Object.entries(config.printers || {}).forEach(([id, printer]) => {
          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid var(--border-color)';
          tr.innerHTML = `
            <td style="padding: 10px 8px; font-weight: 600; color: var(--text-main);">${printer.name}</td>
            <td style="padding: 10px 8px;"><span class="badge" style="background: ${printer.colorMode === 'bw' ? '#f1f5f9' : printer.colorMode === 'color' ? '#fef3c7' : '#dcfce7'}; color: ${printer.colorMode === 'bw' ? '#475569' : printer.colorMode === 'color' ? '#d97706' : '#15803d'}; font-size: 0.65rem;">${printer.colorMode.toUpperCase()}</span></td>
            <td style="padding: 10px 8px; font-weight: 500;">${printer.paperSize || 'A4'}</td>
            <td style="padding: 10px 8px; text-transform: capitalize;">${printer.scale || 'fit'}</td>
            <td style="padding: 10px 8px; color: var(--text-muted);">${printer.maxPages} pages</td>
            <td style="padding: 10px 8px; color: var(--text-muted);">${printer.cooldownMin} min</td>
            <td style="padding: 10px 8px; text-align: right; width: 140px;">
              <button class="btn btn-edit-printer" data-id="${id}" style="padding: 4px 10px; font-size: 0.72rem; width: auto; background: #64748b; margin-right: 6px;">Edit</button>
              <button class="btn btn-delete-printer" data-id="${id}" style="padding: 4px 10px; font-size: 0.72rem; width: auto; background: var(--danger-color)">Delete</button>
            </td>
          `;
          printersTbody.appendChild(tr);
        });

        // Bind Edit buttons
        document.querySelectorAll('.btn-edit-printer').forEach(btn => {
          btn.onclick = () => {
            const id = btn.getAttribute('data-id');
            const printer = config.printers[id];
            
            document.getElementById('modal-title').textContent = '⚙️ Edit Printer Configuration';
            document.getElementById('modal-printer-id').value = id;
            document.getElementById('modal-printer-device').value = printer.name;
            document.getElementById('modal-printer-color').value = printer.colorMode;
            document.getElementById('modal-max-pages').value = printer.maxPages;
            document.getElementById('modal-cooldown').value = printer.cooldownMin || '';
            document.getElementById('modal-paper-size').value = printer.paperSize || 'A4';
            document.getElementById('modal-page-scaling').value = printer.scale || 'fit';

            document.getElementById('limits-modal-overlay').style.display = 'flex';
          };
        });

        // Bind Delete buttons
        document.querySelectorAll('.btn-delete-printer').forEach(btn => {
          btn.onclick = async () => {
            const id = btn.getAttribute('data-id');
            if (confirm('Are you sure you want to delete this printer?')) {
              try {
                const response = await fetch(`/api/printers?id=${id}`, {
                  method: 'DELETE',
                  headers: { 
                    'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
                  }
                });
                const res = await response.json();
                if (res.success) {
                  loadDashboardData();
                } else {
                  alert(res.error || 'Failed to delete printer.');
                }
              } catch (err) {
                alert('Connection error.');
              }
            }
          };
        });
      }

      // Update real-time logs table
      const logsJson = JSON.stringify(config.logs || []);
      const tbody = document.getElementById('logs-tbody');
      const emptyState = document.getElementById('empty-state');
      if (tbody && tbody.getAttribute('data-state') !== logsJson) {
        tbody.setAttribute('data-state', logsJson);
        tbody.innerHTML = '';

        if (config.logs && config.logs.length > 0) {
          emptyState.style.display = 'none';
          
          config.logs.forEach(log => {
            const tr = document.createElement('tr');
            
            // Build action buttons for print queues
            let actionBtn = '';
            const isPending = log.status === 'pending' || log.status === 'pending_payment';
            if (isPending) {
              const priorityText = log.priority ? '⭐ High Priority' : '⚡ Boost Priority';
              const priorityBg = log.priority ? '#b45309' : '#64748b';
              actionBtn += `<button class="btn btn-priority" data-id="${log.id}" data-val="${!log.priority}" style="padding: 4px 10px; font-size: 0.72rem; width: auto; background: ${priorityBg}; margin-right: 6px;">${priorityText}</button>`;
            }
            if (log.status === 'pending' || log.status === 'printing') {
              actionBtn += `<button class="btn btn-failed" data-id="${log.id}" style="padding: 4px 10px; font-size: 0.72rem; width: auto; background: var(--danger-color)">Cancel / Fail</button>`;
            }

            if (log.priority && isPending) {
              tr.style.background = '#fff1f2';
            }
            tr.innerHTML = `
              <td>${log.timestamp}</td>
              <td style="font-weight: 700; color: #3d5e35;">${log.token}</td>
              <td>${log.printType === 'bw' ? '🔳 B&W' : '🌈 Color'}</td>
              <td>${log.sheets}</td>
              <td>${log.copies}</td>
              <td style="font-weight: 600;">₹${log.cost.toFixed(2)}</td>
              <td><span class="badge badge-${log.status}">${log.status}</span></td>
              <td>${actionBtn}</td>
            `;
            tbody.appendChild(tr);
          });

          // Bind Action click listeners
          document.querySelectorAll('.btn-priority').forEach(btn => {
            btn.onclick = async () => {
              const jobId = btn.getAttribute('data-id');
              const priorityVal = btn.getAttribute('data-val') === 'true';
              try {
                const response = await fetch(`/api/jobs/${jobId}/priority`, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
                  },
                  body: JSON.stringify({ priority: priorityVal })
                });
                const res = await response.json();
                if (res.success) {
                  loadDashboardData();
                }
              } catch (err) {
                console.error(err);
              }
            };
          });

          document.querySelectorAll('.btn-failed').forEach(btn => {
            btn.onclick = async () => {
              const jobId = btn.getAttribute('data-id');
              try {
                const response = await fetch(`/api/jobs/${jobId}/status`, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
                  },
                  body: JSON.stringify({ status: 'failed', errorMessage: 'Cancelled by merchant.' })
                });
                const res = await response.json();
                if (res.success) {
                  loadDashboardData();
                }
              } catch (err) {
                console.error(err);
              }
            };
          });

          // Show notifications on new pending jobs
          config.logs.forEach(log => {
            if ((log.status === 'pending' || log.status === 'pending_payment') && !knownJobTokens.has(log.token)) {
              knownJobTokens.add(log.token);
              showNotification('New Print Job Received!', `Token: ${log.token} (${log.printType === 'bw' ? 'B&W' : 'Color'}, ${log.sheets} pages)`);
            }
          });
        } else {
          emptyState.style.display = 'block';
        }
      }

      // Update Print Preview pane monitors
      updateOngoingMonitors(config);

    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }

  // Generate dynamic ongoing preview card blocks
  function updateOngoingMonitors(config) {
    const previewContainer = document.getElementById('preview-cards-container');
    if (!previewContainer) return;

    const currentBwId = config.activeBwJob ? config.activeBwJob.id : null;
    const currentColorId = config.activeColorJob ? config.activeColorJob.id : null;

    let html = '';
    if (config.activeBwJob) {
      html += `
        <div class="ongoing-card" id="ongoing-bw-card">
          <div class="ongoing-header">
            <span class="printer-tag">B&W Printer Channel</span>
            <span class="badge badge-printing">Printing</span>
          </div>
          <div class="ongoing-title">Job Token: ${config.activeBwJob.tokenNumber}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:-6px;">Cost: ₹${config.activeBwJob.cost} | Pages: ${config.activeBwJob.totalPages} sheets</div>
          <div class="ongoing-viewer" id="ongoing-bw-viewer"></div>
          <button class="btn btn-failed" data-id="${config.activeBwJob.id}" style="font-size:0.8rem;padding:6px;width:100%;margin-top:4px;">Mark Failed</button>
        </div>
      `;
    }
    if (config.activeColorJob) {
      html += `
        <div class="ongoing-card" id="ongoing-color-card">
          <div class="ongoing-header">
            <span class="printer-tag">Color Printer Channel</span>
            <span class="badge badge-printing">Printing</span>
          </div>
          <div class="ongoing-title">Job Token: ${config.activeColorJob.tokenNumber}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:-6px;">Cost: ₹${config.activeColorJob.cost} | Pages: ${config.activeColorJob.totalPages} sheets</div>
          <div class="ongoing-viewer" id="ongoing-color-viewer"></div>
          <button class="btn btn-failed" data-id="${config.activeColorJob.id}" style="font-size:0.8rem;padding:6px;width:100%;margin-top:4px;">Mark Failed</button>
        </div>
      `;
    }

    if (!config.activeBwJob && !config.activeColorJob) {
      html = `
        <div class="viewer-empty" style="padding: 40px 10px;">
          <span>😴</span>
          <p>No active print jobs are currently printing in the queues.</p>
        </div>
      `;
    }

    previewContainer.innerHTML = html;

    // Trigger canvas preview generation if job ids changed
    if (config.activeBwJob && currentBwId !== activeBwJobId) {
      activeBwJobId = currentBwId;
      const container = document.getElementById('ongoing-bw-viewer');
      if (container) renderPDFPreview(config.activeBwJob.fileUrl, container);
    }
    if (config.activeColorJob && currentColorId !== activeColorJobId) {
      activeColorJobId = currentColorId;
      const container = document.getElementById('ongoing-color-viewer');
      if (container) renderPDFPreview(config.activeColorJob.fileUrl, container);
    }

    // Re-bind click event on cancel buttons inside preview monitor cards
    previewContainer.querySelectorAll('.btn-failed').forEach(btn => {
      btn.onclick = async () => {
        const jobId = btn.getAttribute('data-id');
        try {
          await fetch(`/api/jobs/${jobId}/status`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
            },
            body: JSON.stringify({ status: 'failed', errorMessage: 'Cancelled from preview console.' })
          });
          loadDashboardData();
        } catch (err) {}
      };
    });
  }

  // Toggle preview monitor panel visibility
  const btnTogglePreview = document.getElementById('btn-toggle-preview');
  btnTogglePreview.addEventListener('click', () => {
    const container = document.getElementById('dashboard-container');
    const isActive = container.classList.toggle('preview-active');
    btnTogglePreview.classList.toggle('active', isActive);
  });

  // Fetch installed system printers once
  async function loadPrinters() {
    try {
      const response = await fetch('/api/printers');
      const data = await response.json();
      const selectDevice = document.getElementById('modal-printer-device');
      if (selectDevice) {
        selectDevice.innerHTML = '<option value="">-- Select Printer Device --</option>';
        data.printers.forEach(pName => {
          const opt = document.createElement('option');
          opt.value = pName;
          opt.textContent = pName;
          selectDevice.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn('Failed to load system printers dropdown:', err.message);
    }
  }

  // Add Printer Button handler
  document.getElementById('btn-add-printer').addEventListener('click', () => {
    document.getElementById('modal-title').textContent = '➕ Add Printer Configuration';
    document.getElementById('modal-printer-id').value = '';
    document.getElementById('modal-printer-device').value = '';
    document.getElementById('modal-printer-color').value = 'both';
    document.getElementById('modal-max-pages').value = '80';
    document.getElementById('modal-cooldown').value = '';
    document.getElementById('modal-paper-size').value = 'A4';
    document.getElementById('modal-page-scaling').value = 'fit';

    document.getElementById('limits-modal-overlay').style.display = 'flex';
  });

  // Modal Cancel limits config handler
  document.getElementById('btn-cancel-modal').addEventListener('click', () => {
    document.getElementById('limits-modal-overlay').style.display = 'none';
  });

  // Save Printer configuration submit handler
  document.getElementById('form-limits-modal').addEventListener('submit', async (e) => {
    e.preventDefault();
    const printerId = document.getElementById('modal-printer-id').value || 'printer_' + Date.now();
    const name = document.getElementById('modal-printer-device').value;
    const colorMode = document.getElementById('modal-printer-color').value;
    const maxPages = parseInt(document.getElementById('modal-max-pages').value) || 80;
    const cooldownMin = parseInt(document.getElementById('modal-cooldown').value) || 0;
    const paperSize = document.getElementById('modal-paper-size').value;
    const scale = document.getElementById('modal-page-scaling').value;

    const payload = {
      printers: {
        [printerId]: { id: printerId, name, colorMode, maxPages, cooldownMin, paperSize, scale }
      }
    };

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
        },
        body: JSON.stringify(payload)
      });
      const res = await response.json();
      if (res.success) {
        document.getElementById('limits-modal-overlay').style.display = 'none';
        loadDashboardData();
      } else {
        alert(res.error || 'Failed to save printer config.');
      }
    } catch (err) {
      alert('Save request failed.');
    }
  });

  // Submit Rate/UPI configuration
  document.getElementById('form-prices').addEventListener('submit', async (e) => {
    e.preventDefault();
    const bwPrice = parseFloat(document.getElementById('input-bw-price').value);
    const colorPrice = parseFloat(document.getElementById('input-color-price').value);
    const upiId = document.getElementById('input-upi-id').value;

    const payload = { bwPrice, colorPrice, upiId };

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
        },
        body: JSON.stringify(payload)
      });
      const res = await response.json();
      if (res.success) {
        alert(res.message);
      }
    } catch (err) {
      alert('Failed to update cloud configurations.');
    }
  });

  // Submit Force Price setup overlay
  const forceSetupForm = document.getElementById('form-setup-prices');
  if (forceSetupForm) {
    forceSetupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bwPrice = document.getElementById('setup-bw-price').value;
      const colorPrice = document.getElementById('setup-color-price').value;
      const maxPages = 80;
      const cooldownMin = 5;

      const defaultPrinterId = 'printer_default';
      const defaultPrinterSetup = {
        [defaultPrinterId]: {
          id: defaultPrinterId,
          name: 'SYSTEM DEFAULT',
          colorMode: 'both',
          maxPages,
          cooldownMin,
          paperSize: 'A4',
          scale: 'fit'
        }
      };

      try {
        const response = await fetch('/api/settings', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (localStorage.getItem('dashboard_token') || '')
          },
          body: JSON.stringify({ bwPrice, colorPrice, printers: defaultPrinterSetup })
        });
        const res = await response.json();
        if (res.success) {
          document.getElementById('price-setup-overlay').style.display = 'none';
          loadDashboardData();
        }
      } catch (err) {
        alert('Failed to set initial prices.');
      }
    });
  }

  // Load static printer list once
  loadPrinters().then(() => {
    loadDashboardData();
    setInterval(loadDashboardData, 3000);
  });
});
