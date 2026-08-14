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
  // Check redirect if authenticated
  const authenticated = localStorage.getItem('dashboard_authenticated');
  if (authenticated === 'true') {
    window.location.href = 'dashboard.html';
    return;
  }

  // Toggle password show/hide buttons
  function setupPasswordToggle(inputId, toggleBtnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(toggleBtnId);
    if (input && btn) {
      btn.addEventListener('click', () => {
        if (input.type === 'password') {
          input.type = 'text';
          btn.innerText = 'Hide';
        } else {
          input.type = 'password';
          btn.innerText = 'Show';
        }
      });
    }
  }
  setupPasswordToggle('input-password', 'btn-toggle-password');
  setupPasswordToggle('input-confirm-password', 'btn-toggle-confirm-password');

  // Password strength rules validation
  const inputPassword = document.getElementById('input-password');
  const inputConfirmPassword = document.getElementById('input-confirm-password');

  function validatePasswordStrength() {
    if (!inputPassword || !inputConfirmPassword) return false;
    const val = inputPassword.value;
    const confirmVal = inputConfirmPassword.value;
    
    const hasLength = val.length >= 8;
    const hasNumber = /\d/.test(val);
    const hasLetter = /[a-zA-Z]/.test(val);
    const isMatch = val === confirmVal && val.length > 0;

    function updateRuleState(elementId, isValid) {
      const el = document.getElementById(elementId);
      if (el) {
        if (isValid) {
          el.classList.remove('invalid');
          el.classList.add('valid');
        } else {
          el.classList.remove('valid');
          el.classList.add('invalid');
        }
      }
    }

    updateRuleState('req-length', hasLength);
    updateRuleState('req-number', hasNumber);
    updateRuleState('req-letter', hasLetter);
    updateRuleState('req-match', isMatch);

    let score = 0;
    if (hasLength) score++;
    if (hasNumber) score++;
    if (hasLetter) score++;
    
    const bar = document.getElementById('strength-bar');
    const text = document.getElementById('strength-text');
    
    if (bar && text) {
      if (val.length === 0) {
        bar.style.width = '0%';
        bar.style.background = '#e2e8f0';
        text.innerText = 'Password Strength';
        text.style.color = '#64748b';
      } else if (score <= 1) {
        bar.style.width = '33%';
        bar.style.background = '#dc2626';
        text.innerText = 'Strength: Weak';
        text.style.color = '#dc2626';
      } else if (score === 2) {
        bar.style.width = '66%';
        bar.style.background = '#d97706';
        text.innerText = 'Strength: Medium';
        text.style.color = '#d97706';
      } else {
        bar.style.width = '100%';
        bar.style.background = '#16a34a';
        text.innerText = 'Strength: Strong';
        text.style.color = '#16a34a';
      }
    }

    return hasLength && hasNumber && hasLetter && isMatch;
  }

  if (inputPassword && inputConfirmPassword) {
    inputPassword.addEventListener('input', validatePasswordStrength);
    inputConfirmPassword.addEventListener('input', validatePasswordStrength);
  }

  // Auth form submit
  const formLogin = document.getElementById('form-login-new');
  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const authErrorMsg = document.getElementById('auth-error-message');
      if (authErrorMsg) authErrorMsg.style.display = 'none';
      
      const authAction = formLogin.getAttribute('data-action') || 'login';

      if (authAction === 'register') {
        const isStrong = validatePasswordStrength();
        if (!isStrong) {
          authErrorMsg.innerText = '❌ Please satisfy all password validation requirements.';
          authErrorMsg.style.display = 'block';
          return;
        }
      }

      const btnAuthSpinner = document.getElementById('btn-auth-spinner');
      const submitBtn = document.getElementById('btn-auth-submit');
      if (btnAuthSpinner) btnAuthSpinner.style.display = 'inline-block';
      if (submitBtn) submitBtn.disabled = true;

      const shopName = document.getElementById('input-shop-name')?.value || '';
      const email = document.getElementById('input-shopkeeper-email')?.value || '';
      const shopId = document.getElementById('input-shop-id')?.value || '';
      const password = document.getElementById('input-password')?.value || '';

      try {
        const endpoint = authAction === 'register' ? '/api/register' : '/api/login';
        const payload = authAction === 'register' 
          ? { shopName, email, password }
          : { shopId, password };
          
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        
        if (btnAuthSpinner) btnAuthSpinner.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;

        if (result.success) {
          if (authAction === 'register') {
            document.getElementById('confirmation-shopid').innerText = result.shopId;
            
            document.getElementById('btn-copy-shopid').onclick = (ev) => {
              copyTextToClipboard(result.shopId, ev.target);
            };
            document.getElementById('btn-confirm-continue').onclick = () => {
              localStorage.setItem('dashboard_authenticated', 'true');
              localStorage.setItem('dashboard_shop_id', result.shopId);
              if (result.token) localStorage.setItem('dashboard_token', result.token);
              window.location.href = 'dashboard.html';
            };

            document.getElementById('auth-form-block').style.display = 'none';
            document.getElementById('confirmation-screen').style.display = 'flex';
          } else {
            localStorage.setItem('dashboard_authenticated', 'true');
            localStorage.setItem('dashboard_shop_id', result.shopId);
            if (result.token) localStorage.setItem('dashboard_token', result.token);
            window.location.href = 'dashboard.html';
          }
        } else {
          if (authErrorMsg) {
            authErrorMsg.innerText = '❌ ' + (result.error || 'Authentication failed.');
            authErrorMsg.style.display = 'block';
          }
        }
      } catch (err) {
        if (btnAuthSpinner) btnAuthSpinner.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;
        if (authErrorMsg) {
          authErrorMsg.innerText = '❌ Failed to connect to server: ' + err.message;
          authErrorMsg.style.display = 'block';
        }
      }
    });
  }

  // Forgot password flow
  const btnForgotPassword = document.getElementById('btn-forgot-password');
  if (btnForgotPassword) {
    btnForgotPassword.addEventListener('click', (e) => {
      e.preventDefault();
      const forgotOverlay = document.getElementById('forgot-password-overlay');
      if (forgotOverlay) forgotOverlay.style.display = 'flex';
    });
  }

  const btnCloseForgot = document.getElementById('btn-close-forgot');
  if (btnCloseForgot) {
    btnCloseForgot.addEventListener('click', () => {
      const forgotOverlay = document.getElementById('forgot-password-overlay');
      if (forgotOverlay) forgotOverlay.style.display = 'none';
    });
  }

  const formForgot = document.getElementById('form-forgot-password');
  if (formForgot) {
    formForgot.addEventListener('submit', async (e) => {
      e.preventDefault();
      const shopIdVal = document.getElementById('forgot-shop-id').value;
      const emailVal = document.getElementById('forgot-email').value;
      const newPasswordVal = document.getElementById('forgot-new-password').value;

      try {
        const response = await fetch('/api/v1/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId: shopIdVal, email: emailVal, newPassword: newPasswordVal })
        });
        const res = await response.json();
        if (response.ok) {
          alert('Password reset requested! Check console for simulated OTP code.');
          const otpChangeOverlay = document.getElementById('otp-change-overlay');
          const otpEmail = document.getElementById('otp-change-email');
          const otpShopId = document.getElementById('otp-change-shopid');
          if (otpChangeOverlay && otpEmail && otpShopId) {
            otpEmail.value = emailVal;
            otpShopId.value = shopIdVal;
            document.getElementById('forgot-password-overlay').style.display = 'none';
            otpChangeOverlay.style.display = 'flex';
          } else {
            alert('Password updated successfully. Please log in.');
            document.getElementById('forgot-password-overlay').style.display = 'none';
          }
        } else {
          alert('Error: ' + res.error);
        }
      } catch (err) {
        alert('Reset password request failed: ' + err.message);
      }
    });
  }

  // OTP change form submit
  const formOtpChange = document.getElementById('form-otp-change');
  if (formOtpChange) {
    formOtpChange.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('otp-change-email').value;
      const shopId = document.getElementById('otp-change-shopid').value;
      const token = document.getElementById('input-otp-change-code').value;

      try {
        const response = await fetch('/api/v1/auth/otp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, shopId, token })
        });
        const res = await response.json();
        if (response.ok) {
          alert('OTP Verified! Password change is successfully confirmed.');
          document.getElementById('otp-change-overlay').style.display = 'none';
        } else {
          alert('Verification failed: ' + res.error);
        }
      } catch (err) {
        alert('Verification failed: ' + err.message);
      }
    });
  }
});
