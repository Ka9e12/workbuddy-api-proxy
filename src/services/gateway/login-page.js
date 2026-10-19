/**
 * 登录页面 HTML 生成器
 * 内嵌 RSA 公钥，使用 Web Crypto API 加密密码
 * @module services/gateway/login-page
 */

/**
 * 生成登录页面 HTML
 * @param {string} returnUrl - 登录成功后的跳转地址
 * @param {string} publicKeyPem - RSA 公钥 PEM
 * @param {boolean} [authEnabled=true] - 是否启用了密码校验（false=免密模式）
 * @returns {string} 完整的 HTML 页面
 */
export function getLoginHtml(returnUrl, publicKeyPem, authEnabled = true) {
    const safeReturnUrl = encodeURIComponent(returnUrl || '/');
    // 将 PEM 中的换行转为 \n 供 JS 字符串使用
    const escapedPublicKey = publicKeyPem.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
    const noPasswordHint = authEnabled
        ? ''
        : '        <div style="padding:10px 12px;background:#0d2a1a;border:1px solid #1e5a38;border-radius:8px;color:#3fb950;font-size:0.85rem;margin-bottom:16px;">未设置密码（免密模式）：直接点击下方「登录」即可进入。</div>\n';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - WorkBuddy API Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      max-width: 400px;
      width: 100%;
      padding: 48px 24px;
    }
    .login-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .login-header h1 {
      font-size: 1.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }
    .login-header p {
      color: #8b949e;
      font-size: 0.9rem;
    }
    .login-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 24px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-group label {
      display: block;
      font-size: 0.85rem;
      color: #8b949e;
      margin-bottom: 6px;
    }
    .input-wrapper {
      position: relative;
    }
    .form-input {
      width: 100%;
      padding: 10px 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      color: #e6edf3;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-input:focus {
      border-color: #667eea;
    }
    .form-input::placeholder {
      color: #484f58;
    }
    .toggle-password {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: #8b949e;
      cursor: pointer;
      font-size: 0.85rem;
      padding: 4px;
    }
    .toggle-password:hover {
      color: #e6edf3;
    }
    .login-btn {
      width: 100%;
      padding: 10px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s, box-shadow 0.2s;
    }
    .login-btn:hover {
      opacity: 0.9;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .login-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .error-message {
      display: none;
      padding: 10px 12px;
      background: #3d1418;
      border: 1px solid #6e2b2f;
      border-radius: 8px;
      color: #f85149;
      font-size: 0.85rem;
      margin-bottom: 16px;
    }
    .error-message.visible {
      display: block;
    }
    .rate-limit-message {
      display: none;
      padding: 10px 12px;
      background: #3d2e00;
      border: 1px solid #6e5a1e;
      border-radius: 8px;
      color: #d29922;
      font-size: 0.85rem;
      margin-bottom: 16px;
    }
    .rate-limit-message.visible {
      display: block;
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      color: #484f58;
      font-size: 0.8rem;
    }
    .loading-spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-header">
      <h1>WorkBuddy API Proxy</h1>
      <p>请登录进行下一步</p>
    </div>
    <div class="login-card">
      <div class="error-message" id="errorMsg"></div>
      <div class="rate-limit-message" id="rateLimitMsg"></div>
      ${noPasswordHint}      <form id="loginForm" onsubmit="return handleLogin(event)">
        <div class="form-group">
          <label for="username">用户名</label>
          <input type="text" id="username" class="form-input" placeholder="留空直接登录（未设密码时）" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <div class="input-wrapper">
            <input type="password" id="password" class="form-input" placeholder="留空直接登录（未设密码时）" autocomplete="current-password" style="padding-right: 44px;">
            <button type="button" class="toggle-password" onclick="togglePasswordVisibility()">显示</button>
          </div>
        </div>
        <button type="submit" class="login-btn" id="loginBtn">登录</button>
      </form>
    </div>
    <div class="footer">
        <span>Powered by <a href="https://github.com/Ka9e12/workbuddy-api-proxy" style="color: #8b949e;" target="_blank" rel="noopener">WorkBuddy API Proxy</a></span>
    </div>
  </div>

  <script>
    const PUBLIC_KEY_PEM = '${escapedPublicKey}';
    const RETURN_URL = decodeURIComponent('${safeReturnUrl}');

    function togglePasswordVisibility() {
      const input = document.getElementById('password');
      const btn = document.querySelector('.toggle-password');
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    }

    function showError(msg) {
      const el = document.getElementById('errorMsg');
      el.textContent = msg;
      el.classList.add('visible');
      document.getElementById('rateLimitMsg').classList.remove('visible');
    }

    function showRateLimit(retryAfter) {
      const el = document.getElementById('rateLimitMsg');
      const seconds = Math.ceil(retryAfter / 1000);
      el.textContent = 'Too many failed attempts. Please try again in ' + seconds + ' seconds.';
      el.classList.add('visible');
      document.getElementById('errorMsg').classList.remove('visible');

      // 倒计时
      let remaining = seconds;
      const timer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(timer);
          el.classList.remove('visible');
        } else {
          el.textContent = 'Too many failed attempts. Please try again in ' + remaining + ' seconds.';
        }
      }, 1000);
    }

    function hideErrors() {
      document.getElementById('errorMsg').classList.remove('visible');
      document.getElementById('rateLimitMsg').classList.remove('visible');
    }

   function isSecureContext() {
     return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
   }
    async function importPublicKey(pem) {
      if (!crypto.subtle) {
        throw new Error('Web Crypto API is not available. Please access this page via HTTPS or localhost.');
       }
     // 解析 PEM 格式公钥
      const pemBody = pem
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\\n/g, '')
        .replace(/\\s/g, '');
      const binaryDer = atob(pemBody);
      const buffer = new Uint8Array(binaryDer.length);
      for (let i = 0; i < binaryDer.length; i++) {
        buffer[i] = binaryDer.charCodeAt(i);
      }
      return await crypto.subtle.importKey(
        'spki',
        buffer.buffer,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt']
      );
    }

    async function encryptPassword(password) {
      // 空密码（免密模式）：无需加密，直接返回空串由服务端判定
      if (!password) {
        return '';
      }
      if (!isSecureContext() || !crypto.subtle) {
         // 非安全上下文：明文传输（仅用于开发/内网环境）
         return password;
      }
      const publicKey = await importPublicKey(PUBLIC_KEY_PEM);
      const encoder = new TextEncoder();
      const data = encoder.encode(password);
      const encrypted = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        data
      );
      // 转为 Base64
      const bytes = new Uint8Array(encrypted);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    async function handleLogin(event) {
      event.preventDefault();
      hideErrors();

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const btn = document.getElementById('loginBtn');

      // 免密模式：两者都为空时允许直接提交（由服务端判定）；
      // 只填了其中一个则提示补全
      if ((!username && password) || (username && !password)) {
        showError('请填写完整的用户名和密码，或两者都留空直接登录');
        return false;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="loading-spinner"></span>Signing in...';

      try {
        // RSA 加密密码
        const encryptedPassword = await encryptPassword(password);

        const response = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: username,
            encrypted_password: encryptedPassword,
            return_url: RETURN_URL
          })
        });

        if (response.ok) {
          // 登录成功，跳转
          const data = await response.json();
          window.location.href = data.redirect || RETURN_URL || '/';
        } else if (response.status === 429) {
          // 速率限制
          const data = await response.json();
          showRateLimit(data.retry_after * 1000 || 300000);
        } else {
          // 认证失败
          const data = await response.json();
          showError(data.error || 'Invalid credentials');
        }
      } catch (err) {
        showError('Login failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }

      return false;
    }
  </script>
</body>
</html>`;
}
