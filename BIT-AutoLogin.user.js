// ==UserScript==
// @name         BIT-AutoLogin
// @namespace    https://github.com/GGBondHere/BIT-AutoLogin-UserScript
// @version      2.0.1
// @description  通过脚本实现BIT网站自动登录，可在任意学校网站页面通过一个总菜单管理所有操作。
// @author       GGBondHere
// @license      MIT
// @match        *://*.bit.edu.cn/*
// @icon         https://www.bit.edu.cn/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/GGBondHere/BIT-AutoLogin-UserScript/main/BIT-AutoLogin.user.js
// @updateURL    https://raw.githubusercontent.com/GGBondHere/BIT-AutoLogin-UserScript/main/BIT-AutoLogin.user.js
// ==/UserScript==

(function () {
  'use strict';

  const IS_NODE_TEST = Boolean(
    typeof module === 'object' &&
      module.exports &&
      typeof process === 'object' &&
      process.versions?.node
  );

  const PROFILE_KEY = 'bit_login_profile_v2';
  const ATTEMPT_KEY = 'bit_login_attempt_v2';
  const LEGACY_USERNAME_KEY = 'bit_login_username';
  const LEGACY_PASSWORD_KEY = 'bit_login_password';
  const LEGACY_ATTEMPT_KEY = 'bit_login_last_submit_v2';
  const DEFAULT_COOLDOWN_MS = 30_000;
  const RATE_LIMIT_COOLDOWN_MS = 120_000;
  const SUBMIT_DELAY_MS = 700;
  const MANUAL_RETRY_GRACE_MS = 1_000;
  const ATTEMPT_RESERVATION_MS = SUBMIT_DELAY_MS + 5_000;
  const ATTEMPT_LEDGER_LIMIT = 16;

  function createDefaultProfile() {
    return {
      schema: 2,
      username: '',
      secret: '',
      autoSubmit: true,
      showLauncher: true,
    };
  }

  function normalizeProfile(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      schema: 2,
      username: typeof source.username === 'string' ? source.username.trim() : '',
      secret: typeof source.secret === 'string' ? source.secret : '',
      autoSubmit: source.autoSubmit !== false,
      showLauncher: source.showLauncher !== false,
    };
  }

  function migrateLegacyProfile(currentProfile, legacy = {}) {
    const profile = normalizeProfile(currentProfile);
    if (profile.username && profile.secret) return profile;

    const legacyUsername =
      typeof legacy.username === 'string' ? legacy.username.trim() : '';
    const legacySecret = typeof legacy.secret === 'string' ? legacy.secret : '';
    if (!legacyUsername || !legacySecret) return profile;
    if (profile.username && profile.username !== legacyUsername) return profile;

    return {
      ...profile,
      username: profile.username || legacyUsername,
      secret: profile.secret || legacySecret,
    };
  }

  function xorText(text, key) {
    let output = '';
    for (let index = 0; index < text.length; index += 1) {
      output += String.fromCharCode(
        text.charCodeAt(index) ^ key.charCodeAt(index % key.length)
      );
    }
    return output;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(bytes).toString('base64');
  }

  function base64ToBytes(value) {
    const binary =
      typeof atob === 'function'
        ? atob(value)
        : Buffer.from(value, 'base64').toString('binary');
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function encodeSecret(password, username) {
    const encoder = new TextEncoder();
    const input = encoder.encode(String(password));
    const key = encoder.encode('bit-login-assistant-v2|' + String(username));
    const output = input.map((byte, index) => byte ^ key[index % key.length]);
    return 'v2:' + bytesToBase64(output);
  }

  function decodeSecret(secret, username) {
    if (!secret || !username) return '';
    const stored = String(secret);

    if (stored.startsWith('v2:')) {
      const input = base64ToBytes(stored.slice(3));
      const key = new TextEncoder().encode(
        'bit-login-assistant-v2|' + String(username)
      );
      const output = input.map((byte, index) => byte ^ key[index % key.length]);
      return new TextDecoder().decode(output);
    }

    const legacyBytes =
      typeof atob === 'function'
        ? atob(stored)
        : Buffer.from(stored, 'base64').toString('binary');
    return xorText(legacyBytes, 'bit_webvpn_key_' + String(username));
  }

  function resolveCredentialUpdate({
    currentUsername = '',
    currentPassword = '',
    nextUsername = '',
    nextPassword = '',
  } = {}) {
    const username = String(nextUsername).trim();
    const password = String(nextPassword);
    if (!username) throw new Error('学号不能为空');
    if (password) return { username, password };
    if (currentUsername && username !== currentUsername) {
      throw new Error('修改学号时必须重新输入密码');
    }
    if (!currentPassword) throw new Error('密码不能为空');
    return { username, password: currentPassword };
  }

  function redactMessage(text) {
    return String(text || '')
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
      .replace(
        /((?:\b(?:access[_-]?token|response[_-]?token|token|ticket|sms[_-]?code|captcha[_-]?code|password|passwd|phone|mobile|tel)\b|密码|口令|手机号|手机号码|验证码|校验码)["']?\s*[:：=]\s*["']?)[^\s&,;}\])"']+/gi,
        '$1[已隐藏]'
      )
      .replace(/(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d{9})(?!\d)/g, (_, phone) =>
        phone.slice(0, 3) + '****' + phone.slice(-4)
      )
      .slice(0, 500);
  }

  function categorizeMessage(text) {
    const normalized = String(text || '').replace(/\s+/g, '');
    if (!normalized) return 'unknown';

    if (
      /(用户名|账号|学号).{0,8}(或|和)?.{0,4}密码.{0,8}(错误|不正确|无效)|密码.{0,8}(错误|不正确)/.test(
        normalized
      )
    ) {
      return 'credential';
    }
    if (/(验证码|校验码).{0,10}(错误|失效|不正确|过期|拒绝)/.test(normalized)) {
      if (/(图形|图片|图像)|captcha/i.test(normalized)) return 'captcha';
      if (/(短信|邮件|动态|一次性)/.test(normalized)) return 'second-factor';
      return 'verification';
    }
    if (
      /(请求|操作|登录).{0,10}(频繁|过多)|稍后(再试|重试)|(^|[^0-9])429([^0-9]|$)/.test(
        normalized
      )
    ) {
      return 'rate-limit';
    }
    if (
      /服务.{0,8}(不可用|异常|繁忙|维护)|系统.{0,8}(异常|维护|繁忙)|网络.{0,8}(异常|错误)/.test(
        normalized
      )
    ) {
      return 'service';
    }
    return 'unknown';
  }

  function classifyPage({
    hasSecondFactor = false,
    hasSmsLogin = false,
    hasCaptcha = false,
    errorKind = 'unknown',
    hasPasswordForm = false,
  } = {}) {
    if (hasSecondFactor) return 'second-factor';
    if (hasSmsLogin) return 'sms-login';
    if (errorKind === 'credential') return 'credential-error';
    if (errorKind === 'rate-limit') return 'rate-limited';
    if (errorKind === 'service') return 'service-error';
    if (errorKind === 'second-factor') return 'second-factor';
    if (hasCaptcha || errorKind === 'captcha') return 'captcha';
    if (errorKind === 'verification') return hasPasswordForm ? 'captcha' : 'second-factor';
    if (hasPasswordForm) return 'password';
    return 'waiting';
  }

  function canStartPasswordAttempt(snapshot = {}, origin = 'auto') {
    if (snapshot.hasSecondFactor || snapshot.hasSmsLogin || !snapshot.hasPasswordForm) {
      return false;
    }
    if (snapshot.errorKind === 'second-factor') return false;
    if (
      (snapshot.hasCaptcha || ['captcha', 'verification'].includes(snapshot.errorKind)) &&
      !snapshot.captchaReady
    ) {
      return false;
    }
    if (origin !== 'auto') return true;
    return classifyPage(snapshot) === 'password';
  }

  function normalizeAttemptLedger(
    value,
    now = Date.now(),
    fallbackCooldownMs = DEFAULT_COOLDOWN_MS
  ) {
    const source = safeJsonParse(value);
    const candidates = Array.isArray(source?.entries)
      ? source.entries
      : source?.context
        ? [source]
        : [];
    const entriesByContext = new Map();

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const context =
        typeof candidate.context === 'string' ? candidate.context.trim() : '';
      const timestamp = Number(candidate.timestamp);
      const explicitBlockedUntil = Number(candidate.blockedUntil);
      const blockedUntil = Number.isFinite(explicitBlockedUntil)
        ? explicitBlockedUntil
        : timestamp + fallbackCooldownMs;
      if (!context || !Number.isFinite(timestamp) || !Number.isFinite(blockedUntil)) {
        continue;
      }
      if (blockedUntil <= now) continue;

      const entry = {
        context,
        timestamp,
        blockedUntil,
        phase: typeof candidate.phase === 'string' ? candidate.phase : 'submitted',
        owner: typeof candidate.owner === 'string' ? candidate.owner : '',
      };
      const previous = entriesByContext.get(context);
      if (!previous || previous.timestamp <= timestamp) {
        entriesByContext.set(context, entry);
      }
    }

    return {
      schema: 1,
      entries: Array.from(entriesByContext.values())
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, ATTEMPT_LEDGER_LIMIT),
    };
  }

  function upsertAttempt(ledger, attempt, now = Date.now()) {
    const current = normalizeAttemptLedger(ledger, now);
    const candidate = normalizeAttemptLedger(
      { entries: [attempt] },
      now
    ).entries[0];
    if (!candidate) return current;
    return normalizeAttemptLedger(
      {
        schema: 1,
        entries: [
          candidate,
          ...current.entries.filter((entry) => entry.context !== candidate.context),
        ],
      },
      now
    );
  }

  function clearAttemptContext(ledger, context, now = Date.now()) {
    const current = normalizeAttemptLedger(ledger, now);
    return {
      schema: 1,
      entries: current.entries.filter((entry) => entry.context !== context),
    };
  }

  function canAttempt(
    ledger,
    context,
    now = Date.now(),
    cooldownMs = DEFAULT_COOLDOWN_MS
  ) {
    const current = normalizeAttemptLedger(ledger, now, cooldownMs);
    return !current.entries.some(
      (entry) => entry.context === context && entry.blockedUntil > now
    );
  }

  function isAuthLocation(protocol, hostname, pathname) {
    if (protocol !== 'https:') return false;
    const host = String(hostname || '').toLowerCase();
    const path = String(pathname || '').replace(/\/+$/, '');
    if (host === 'sso.bit.edu.cn') return path === '/cas/login';
    if (host === 'webvpn.bit.edu.cn') return /\/cas\/login$/i.test(path);
    return false;
  }

  function safeJsonParse(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (IS_NODE_TEST) {
    module.exports = {
      canStartPasswordAttempt,
      canAttempt,
      categorizeMessage,
      clearAttemptContext,
      classifyPage,
      createDefaultProfile,
      decodeSecret,
      encodeSecret,
      isAuthLocation,
      migrateLegacyProfile,
      normalizeAttemptLedger,
      normalizeProfile,
      resolveCredentialUpdate,
      upsertAttempt,
      xorText,
    };
    return;
  }

  if (window.self !== window.top) return;

  function element(tagName, options = {}) {
    const node = document.createElement(tagName);
    if (options.id) node.id = options.id;
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.type) node.type = options.type;
    if (options.placeholder) node.placeholder = options.placeholder;
    if (options.title) node.title = options.title;
    if (options.attributes) {
      for (const [name, value] of Object.entries(options.attributes)) {
        node.setAttribute(name, String(value));
      }
    }
    return node;
  }

  function isVisible(node) {
    return !node?.disabled && isRendered(node);
  }

  function isRendered(node) {
    if (
      !node ||
      node.hidden ||
      node.getAttribute?.('aria-hidden') === 'true' ||
      node.getAttribute?.('type') === 'hidden'
    ) {
      return false;
    }
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    return node.getClientRects().length > 0;
  }

  function setNativeValue(input, value) {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  class ProfileStore {
    load() {
      const current = safeJsonParse(GM_getValue(PROFILE_KEY, null));
      const profile = migrateLegacyProfile(current, {
        username: GM_getValue(LEGACY_USERNAME_KEY, ''),
        secret: GM_getValue(LEGACY_PASSWORD_KEY, ''),
      });

      if (!current || JSON.stringify(normalizeProfile(current)) !== JSON.stringify(profile)) {
        this.save(profile);
      }
      return profile;
    }

    save(profile) {
      const normalized = normalizeProfile(profile);
      GM_setValue(PROFILE_KEY, JSON.stringify(normalized));
      return normalized;
    }

    update(patch) {
      return this.save({ ...this.load(), ...patch });
    }

    credentials() {
      const profile = this.load();
      if (!profile.username || !profile.secret) {
        return { username: profile.username, password: '', corrupt: false };
      }
      try {
        return {
          username: profile.username,
          password: decodeSecret(profile.secret, profile.username),
          corrupt: false,
        };
      } catch (error) {
        console.error('BIT-AutoLogin：无法读取本地密码。', error);
        return { username: profile.username, password: '', corrupt: true };
      }
    }

    setCredentials(username, password) {
      return this.save({
        ...this.load(),
        username,
        secret: encodeSecret(password, username),
      });
    }

    applyForm(data = {}) {
      const currentCredentials = this.credentials();
      const hasCredentialInput =
        Boolean(String(data.username || '').trim()) ||
        Boolean(data.password) ||
        Boolean(currentCredentials.username);

      if (hasCredentialInput) {
        const next = resolveCredentialUpdate({
          currentUsername: currentCredentials.username,
          currentPassword: currentCredentials.password,
          nextUsername: data.username,
          nextPassword: data.password,
        });
        this.setCredentials(next.username, next.password);
      }

      return this.update({
        autoSubmit: Boolean(data.autoSubmit),
        showLauncher: Boolean(data.showLauncher),
      });
    }

    clearCredentials() {
      const profile = this.save({
        ...this.load(),
        username: '',
        secret: '',
      });
      GM_deleteValue(LEGACY_USERNAME_KEY);
      GM_deleteValue(LEGACY_PASSWORD_KEY);
      return profile;
    }
  }

  class AttemptStore {
    constructor() {
      this.paused = false;
      this.owner =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }

    read() {
      return normalizeAttemptLedger(GM_getValue(ATTEMPT_KEY, null));
    }

    write(ledger) {
      const normalized = normalizeAttemptLedger(ledger);
      GM_setValue(ATTEMPT_KEY, JSON.stringify(normalized));
      GM_deleteValue(LEGACY_ATTEMPT_KEY);
      return normalized;
    }

    reserve(context) {
      const now = Date.now();
      const ledger = this.read();
      if (!canAttempt(ledger, context, now)) return false;
      this.write(
        upsertAttempt(
          ledger,
          {
            context,
            timestamp: now,
            blockedUntil: now + ATTEMPT_RESERVATION_MS,
            phase: 'reserved',
            owner: this.owner,
          },
          now
        )
      );
      return this.ownsReservation(context);
    }

    ownsReservation(context) {
      return this.read().entries.some(
        (entry) =>
          entry.context === context &&
          entry.phase === 'reserved' &&
          entry.owner === this.owner
      );
    }

    record(context, cooldownMs = DEFAULT_COOLDOWN_MS, phase = 'submitted') {
      const timestamp = Date.now();
      const attempt = {
        context,
        timestamp,
        blockedUntil: timestamp + cooldownMs,
        phase,
        owner: this.owner,
      };
      this.write(upsertAttempt(this.read(), attempt, timestamp));
      return attempt;
    }

    release(context) {
      if (!context) return;
      const ledger = this.read();
      const reservation = ledger.entries.find((entry) => entry.context === context);
      if (reservation?.phase !== 'reserved' || reservation.owner !== this.owner) return;
      this.write(clearAttemptContext(ledger, context));
    }

    clear(context = '') {
      if (!context) {
        GM_deleteValue(ATTEMPT_KEY);
        GM_deleteValue(LEGACY_ATTEMPT_KEY);
        return;
      }
      this.write(clearAttemptContext(this.read(), context));
    }

    isPaused() {
      return this.paused;
    }

    setPaused(paused) {
      this.paused = Boolean(paused);
    }
  }

  class AuthPageAdapter {
    constructor(doc = document) {
      this.doc = doc;
    }

    isAuthPage() {
      return isAuthLocation(location.protocol, location.hostname, location.pathname);
    }

    findVisible(selectors) {
      return Array.from(this.doc.querySelectorAll(selectors)).find(
        (node) => !node.closest('#bitla-root') && isVisible(node)
      ) || null;
    }

    passwordForm() {
      const username = this.findVisible('#nameInput, input[name="username"]');
      if (!username) return null;
      const scope = username.closest('form') || this.doc;
      const visible = (selectors) => Array.from(scope.querySelectorAll(selectors)).find(
        (node) => !node.closest('#bitla-root') && isVisible(node)
      );
      const password = visible('input[type="password"]');
      const submit = visible('#submitBtn, button[type="submit"]');
      if (!username || !password || !submit) return null;
      return { username, password, submit };
    }

    errorSignal() {
      const selectors = [
        '.ant-alert-message',
        '#login-error-msg',
        '.login-error',
        '.error-message',
        '[role="alert"]',
        '.ant-message-notice-content',
      ].join(',');
      const priority = {
        credential: 4,
        'rate-limit': 3,
        service: 2,
        'second-factor': 1,
        captcha: 1,
        verification: 1,
        unknown: 0,
      };
      let selected = { kind: 'unknown', message: '' };

      for (const node of this.doc.querySelectorAll(selectors)) {
        if (!isVisible(node)) continue;
        const message = node.textContent?.trim() || '';
        const kind = categorizeMessage(message);
        if (priority[kind] > priority[selected.kind]) selected = { kind, message };
      }
      return selected;
    }

    captchaInput() {
      const scope = this.passwordForm()?.username.closest('form') || this.doc;
      return Array.from(scope.querySelectorAll(
        'input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="图形"], input[placeholder*="图片"]'
      )).find((input) => !input.closest('#bitla-root') && isRendered(input)) || null;
    }

    oneTimeInput() {
      return this.findVisible(
        'input[autocomplete="one-time-code"], input[name="smsCode" i], input[id*="smsCode" i], input[name="otp" i], input[id*="otp" i]'
      );
    }

    hasSmsLogin() {
      if (this.findVisible('form[id*="smsLoginForm" i]:not([id*="second" i])')) return true;
      const phoneInput = this.findVisible(
        'input[type="tel"], input[name="phone" i], input[name="mobile" i], #phoneInput'
      );
      return Boolean(phoneInput && this.oneTimeInput() && !this.passwordForm());
    }

    hasSecondFactor() {
      if (this.findVisible('#secondSmsLoginForm')) return true;

      const metadata = this.doc.querySelector('#user-object-id');
      const visibleStep = this.findVisible(
        '#second-auth-tip, .second-auth-tip, #cas-gateway, [class*="secondSms"]'
      );
      if (metadata?.textContent?.trim() && visibleStep) return true;
      const oneTimeInput = this.oneTimeInput();
      return Boolean(oneTimeInput && oneTimeInput !== this.captchaInput() && !this.hasSmsLogin());
    }

    snapshot() {
      const error = this.errorSignal();
      const captcha = this.captchaInput();
      return {
        hasSecondFactor: this.hasSecondFactor(),
        hasSmsLogin: this.hasSmsLogin(),
        hasCaptcha: Boolean(captcha),
        captchaReady: Boolean(captcha && !captcha.disabled && captcha.value.trim()),
        hasPasswordForm: Boolean(this.passwordForm()),
        errorKind: error.kind,
        message: error.message,
      };
    }

    fillCredentials(username, password) {
      const form = this.passwordForm();
      if (!form) return false;
      setNativeValue(form.username, username);
      setNativeValue(form.password, password);
      return true;
    }

    submitReady() {
      const form = this.passwordForm();
      if (!form) return false;
      const button = form.submit;
      return !(
        button.disabled ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.classList.contains('disabled')
      );
    }

    submit() {
      const form = this.passwordForm();
      if (!form || !this.submitReady() || !canStartPasswordAttempt(this.snapshot(), 'manual')) {
        return false;
      }
      form.submit.click();
      return true;
    }

    context() {
      const url = new URL(location.href);
      const service = url.searchParams.get('service') || 'no-service';
      return [url.hostname, url.pathname, service].join('|');
    }
  }

  class AssistantView {
    constructor() {
      this.root = null;
      this.actions = {};
      this.profile = createDefaultProfile();
      this.currentStatus = 'waiting';
      this.pending = false;
      this.paused = false;
      this.hasCaptcha = false;
      this.captchaReady = false;
      this.settingsOnly = false;
    }

    injectStyles() {
      if (document.getElementById('bitla-styles')) return;
      const style = element('style', { id: 'bitla-styles' });
      style.textContent = `
        #bitla-root{--bitla-bg:#0b1220;--bitla-panel:#101a2d;--bitla-card:#162238;--bitla-line:rgba(255,255,255,.12);--bitla-text:#f7f9fc;--bitla-muted:#b4bfd0;--bitla-accent:#6d8cff;--bitla-accent2:#7f5cff;--bitla-danger:#ff6b7a;--bitla-success:#34d399;--bitla-warning:#fbbf24;color-scheme:dark;font-family:Inter,"Segoe UI","PingFang SC",system-ui,sans-serif;color:var(--bitla-text)}
        #bitla-root *{box-sizing:border-box}
        .bitla-dock{position:fixed;right:22px;bottom:22px;z-index:2147483643;width:min(330px,calc(100vw - 44px));padding:13px;border:1px solid var(--bitla-line);border-radius:18px;color:var(--bitla-text);background:rgba(11,18,32,.96);box-shadow:0 18px 50px rgba(0,0,0,.34);backdrop-filter:blur(18px)}
        .bitla-dock[hidden]{display:none}
        .bitla-status-row{display:flex;align-items:flex-start;gap:10px}
        .bitla-dot{width:9px;height:9px;margin-top:6px;border-radius:50%;background:var(--bitla-muted);box-shadow:0 0 0 4px rgba(158,171,192,.12);flex:none}
        .bitla-dot[data-tone="success"]{background:var(--bitla-success);box-shadow:0 0 0 4px rgba(52,211,153,.13)}
        .bitla-dot[data-tone="warning"]{background:var(--bitla-warning);box-shadow:0 0 0 4px rgba(251,191,36,.13)}
        .bitla-dot[data-tone="danger"]{background:var(--bitla-danger);box-shadow:0 0 0 4px rgba(255,107,122,.13)}
        .bitla-status-copy{min-width:0;flex:1}
        .bitla-status-title{color:var(--bitla-text);font-size:14px;font-weight:700;line-height:1.4}
        .bitla-status-detail{margin-top:3px;color:var(--bitla-muted);font-size:12px;line-height:1.45}
        .bitla-actions{display:flex;gap:8px;margin-top:12px}
        .bitla-btn{appearance:none;border:1px solid var(--bitla-line);border-radius:10px;padding:8px 11px;color:var(--bitla-text);background:rgba(255,255,255,.055);font:600 12px/1 "Segoe UI","PingFang SC",sans-serif;cursor:pointer;transition:background .16s ease,border-color .16s ease,transform .16s ease}
        .bitla-btn:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.17)}
        .bitla-btn:active{transform:translateY(1px)}
        .bitla-btn:disabled{opacity:.42;cursor:not-allowed}
        .bitla-btn-primary{border-color:transparent;background:linear-gradient(135deg,var(--bitla-accent),var(--bitla-accent2))}
        .bitla-btn-danger{color:#ffd8dd;border-color:rgba(255,107,122,.26);background:rgba(255,107,122,.09)}
        .bitla-overlay{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:18px;background:rgba(2,6,15,.66);backdrop-filter:blur(8px)}
        .bitla-overlay[hidden]{display:none}
        .bitla-panel{width:min(640px,100%);max-height:min(760px,calc(100vh - 36px));overflow:auto;border:1px solid var(--bitla-line);border-radius:24px;color:var(--bitla-text);background:linear-gradient(160deg,#111d33 0%,#0a1221 100%);box-shadow:0 28px 90px rgba(0,0,0,.5)}
        .bitla-panel-head{display:flex;align-items:flex-start;justify-content:space-between;padding:22px 22px 16px;border-bottom:1px solid var(--bitla-line)}
        .bitla-kicker{margin:0 0 4px;color:#94a8ff;font-size:11px;font-weight:800;letter-spacing:.12em}
        .bitla-title{margin:0;color:var(--bitla-text)!important;font-size:22px;line-height:1.25}
        .bitla-subtitle{margin:5px 0 0;color:var(--bitla-muted);font-size:13px}
        .bitla-close{width:34px;height:34px;padding:0;border-radius:11px;font-size:18px}
        .bitla-panel-body{display:grid;gap:14px;padding:18px 22px 22px}
        .bitla-card{padding:16px;border:1px solid var(--bitla-line);border-radius:17px;background:rgba(255,255,255,.035)}
        .bitla-card-title{margin:0 0 12px;color:var(--bitla-text)!important;font-size:14px;font-weight:750}
        .bitla-panel-state{color:var(--bitla-muted);font-size:13px;line-height:1.55}
        .bitla-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .bitla-field{display:grid;gap:6px}
        .bitla-label{color:#c9d2e3;font-size:12px;font-weight:650}
        .bitla-input{width:100%;border:1px solid var(--bitla-line);border-radius:11px;padding:11px 12px;color:var(--bitla-text);background:rgba(3,8,18,.48);outline:none;font:14px "Segoe UI","PingFang SC",sans-serif}
        .bitla-input::placeholder{color:#8997ad;opacity:1}
        .bitla-input:focus{border-color:rgba(109,140,255,.75);box-shadow:0 0 0 3px rgba(109,140,255,.13)}
        .bitla-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0}
        .bitla-switch-row+.bitla-switch-row{border-top:1px solid var(--bitla-line)}
        .bitla-switch-copy strong{display:block;color:var(--bitla-text)!important;font-size:13px}
        .bitla-switch-copy span{display:block;margin-top:3px;color:var(--bitla-muted);font-size:11px}
        .bitla-switch{position:relative;width:42px;height:24px;flex:none}
        .bitla-switch input{position:absolute;opacity:0;pointer-events:none}
        .bitla-switch-track{position:absolute;inset:0;border-radius:999px;background:#344158;cursor:pointer;transition:background .18s ease}
        .bitla-switch-track::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 2px 7px rgba(0,0,0,.3);transition:transform .18s ease}
        .bitla-switch input:checked+.bitla-switch-track{background:linear-gradient(135deg,var(--bitla-accent),var(--bitla-accent2))}
        .bitla-switch input:checked+.bitla-switch-track::after{transform:translateX(18px)}
        .bitla-footer-actions{display:flex;flex-wrap:wrap;gap:9px}
        .bitla-wide{flex:1;min-width:130px}
        .bitla-note{margin:10px 0 0;color:var(--bitla-muted);font-size:11px;line-height:1.5}
        @media (max-width:620px){.bitla-grid{grid-template-columns:1fr}.bitla-panel-head{padding:18px}.bitla-panel-body{padding:14px 18px 18px}.bitla-dock{right:14px;bottom:14px}}
      `;
      document.head.appendChild(style);
    }

    createSwitch(title, description) {
      const row = element('label', { className: 'bitla-switch-row' });
      const copy = element('span', { className: 'bitla-switch-copy' });
      copy.append(
        element('strong', { text: title }),
        element('span', { text: description })
      );
      const control = element('span', { className: 'bitla-switch' });
      const input = element('input', { type: 'checkbox' });
      control.append(input, element('span', { className: 'bitla-switch-track' }));
      row.append(copy, control);
      return { row, input };
    }

    mount(profile, { settingsOnly = false } = {}) {
      this.settingsOnly = Boolean(settingsOnly);
      if (this.root) {
        this.syncProfile(profile);
        return;
      }
      this.profile = profile;
      this.injectStyles();

      this.root = element('div', { id: 'bitla-root' });
      this.root.dataset.bitlaRoot = 'true';

      this.dock = element('section', {
        className: 'bitla-dock',
        attributes: { 'aria-live': 'polite' },
      });
      const statusRow = element('div', { className: 'bitla-status-row' });
      this.statusDot = element('span', { className: 'bitla-dot' });
      const statusCopy = element('div', { className: 'bitla-status-copy' });
      this.statusText = element('div', {
        className: 'bitla-status-title',
        text: '正在读取登录页面',
      });
      this.statusDetail = element('div', {
        className: 'bitla-status-detail',
        text: '请稍候',
      });
      statusCopy.append(this.statusText, this.statusDetail);
      statusRow.append(this.statusDot, statusCopy);

      const dockActions = element('div', { className: 'bitla-actions' });
      this.quickButton = element('button', {
        className: 'bitla-btn bitla-btn-primary',
        text: '立即登录',
        type: 'button',
      });
      this.pauseButton = element('button', {
        className: 'bitla-btn',
        text: '暂停本页',
        type: 'button',
      });
      const settingsButton = element('button', {
        className: 'bitla-btn',
        text: '设置',
        type: 'button',
      });
      dockActions.append(this.quickButton, this.pauseButton, settingsButton);
      this.dock.append(statusRow, dockActions);

      this.overlay = element('div', { className: 'bitla-overlay' });
      this.overlay.hidden = true;
      const panel = element('section', {
        className: 'bitla-panel',
        attributes: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'bitla-panel-title',
        },
      });
      const head = element('header', { className: 'bitla-panel-head' });
      const headCopy = element('div');
      headCopy.append(
        element('p', { className: 'bitla-kicker', text: 'AUTO LOGIN' }),
        element('h2', {
          id: 'bitla-panel-title',
          className: 'bitla-title',
          text: 'BIT-AutoLogin',
        }),
        element('p', {
          className: 'bitla-subtitle',
          text: '自动登录、状态诊断和凭据管理',
        })
      );
      const closeButton = element('button', {
        className: 'bitla-btn bitla-close',
        text: '×',
        type: 'button',
        attributes: { 'aria-label': '关闭设置' },
      });
      head.append(headCopy, closeButton);

      const body = element('div', { className: 'bitla-panel-body' });
      const stateCard = element('section', { className: 'bitla-card' });
      stateCard.append(
        element('h3', { className: 'bitla-card-title', text: '当前状态' })
      );
      this.panelStatus = element('div', {
        className: 'bitla-panel-state',
        text: '正在读取登录页面',
      });
      stateCard.append(this.panelStatus);

      const credentialCard = element('section', { className: 'bitla-card' });
      credentialCard.append(
        element('h3', { className: 'bitla-card-title', text: '登录凭据' })
      );
      const credentialGrid = element('div', { className: 'bitla-grid' });
      const usernameField = element('label', { className: 'bitla-field' });
      usernameField.append(element('span', { className: 'bitla-label', text: '学号' }));
      this.usernameInput = element('input', {
        className: 'bitla-input',
        type: 'text',
        placeholder: '请输入学号',
      });
      this.usernameInput.autocomplete = 'username';
      usernameField.append(this.usernameInput);
      const passwordField = element('label', { className: 'bitla-field' });
      passwordField.append(element('span', { className: 'bitla-label', text: '密码' }));
      this.passwordInput = element('input', {
        className: 'bitla-input',
        type: 'password',
        placeholder: '留空可保留现有密码',
      });
      this.passwordInput.autocomplete = 'new-password';
      passwordField.append(this.passwordInput);
      credentialGrid.append(usernameField, passwordField);
      credentialCard.append(
        credentialGrid,
        element('p', {
          className: 'bitla-note',
          text: '密码不会回显到页面；本地保存仍属于可逆混淆，请勿在公用电脑使用。',
        })
      );

      const preferenceCard = element('section', { className: 'bitla-card' });
      preferenceCard.append(
        element('h3', { className: 'bitla-card-title', text: '行为设置' })
      );
      const autoSwitch = this.createSwitch(
        '自动提交密码',
        '识别到可见密码表单后自动登录'
      );
      const launcherSwitch = this.createSwitch(
        '显示页面助手',
        '在登录页右下角显示状态和快捷入口'
      );
      this.autoInput = autoSwitch.input;
      this.launcherInput = launcherSwitch.input;
      preferenceCard.append(autoSwitch.row, launcherSwitch.row);

      const actionCard = element('section', { className: 'bitla-card' });
      const footerActions = element('div', { className: 'bitla-footer-actions' });
      const saveButton = element('button', {
        className: 'bitla-btn bitla-btn-primary bitla-wide',
        text: '保存设置',
        type: 'button',
      });
      this.clearButton = element('button', {
        className: 'bitla-btn bitla-btn-danger',
        text: '清除凭据',
        type: 'button',
      });
      footerActions.append(saveButton, this.clearButton);
      actionCard.append(footerActions);

      body.append(stateCard, credentialCard, preferenceCard, actionCard);
      panel.append(head, body);
      this.overlay.appendChild(panel);
      this.root.append(this.dock, this.overlay);
      document.body.appendChild(this.root);

      settingsButton.addEventListener('click', () => this.openPanel());
      closeButton.addEventListener('click', () => this.closePanel());
      this.overlay.addEventListener('click', (event) => {
        if (event.target === this.overlay) this.closePanel();
      });
      this.overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') this.closePanel();
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          this.actions.save?.(this.formData());
        }
      });
      this.quickButton.addEventListener('click', () => this.actions.login?.());
      this.pauseButton.addEventListener('click', () => this.actions.pause?.());
      saveButton.addEventListener('click', () => this.actions.save?.(this.formData()));
      this.clearButton.addEventListener('click', () => this.confirmClear());

      this.syncProfile(profile);
    }

    bind(actions) {
      this.actions = actions;
    }

    formData() {
      return {
        username: this.usernameInput.value,
        password: this.passwordInput.value,
        autoSubmit: this.autoInput.checked,
        showLauncher: this.launcherInput.checked,
      };
    }

    syncProfile(profile) {
      this.profile = profile;
      if (!this.root) return;
      this.usernameInput.value = profile.username;
      this.passwordInput.value = '';
      this.passwordInput.placeholder = profile.secret
        ? '留空以保留现有密码'
        : '请输入密码';
      this.autoInput.checked = profile.autoSubmit;
      this.launcherInput.checked = profile.showLauncher;
      this.applyAssistantVisibility(profile.showLauncher);
    }

    applyAssistantVisibility(visible) {
      if (!this.dock) return;
      this.dock.hidden = this.settingsOnly || !visible;
    }

    openPanel() {
      if (!this.overlay) return;
      this.overlay.hidden = false;
      this.usernameInput?.focus();
    }

    closePanel() {
      if (this.overlay) this.overlay.hidden = true;
    }

    setInteraction({
      pending = this.pending,
      paused = this.paused,
      hasCaptcha = this.hasCaptcha,
      captchaReady = this.captchaReady,
    } = {}) {
      this.pending = pending;
      this.paused = paused;
      this.hasCaptcha = hasCaptcha;
      this.captchaReady = captchaReady;
      if (!this.pauseButton || !this.quickButton) return;
      this.pauseButton.textContent = pending
        ? '取消本次'
        : paused
          ? '恢复本页'
          : '暂停本页';
      this.quickButton.disabled =
        pending ||
        (hasCaptcha && !captchaReady) ||
        ['second-factor', 'sms-login', 'waiting', 'service-error'].includes(this.currentStatus);
    }

    renderStatus(status, detail = '') {
      const states = {
        waiting: ['正在等待登录页面', '页面结构尚未准备完成。', 'neutral'],
        'needs-profile': ['需要设置登录凭据', '打开设置后保存学号和密码。', 'warning'],
        ready: ['可以登录', '点击“立即登录”，或开启自动提交。', 'success'],
        queued: ['凭据已填入', '即将点击学校页面的登录按钮，可立即取消。', 'warning'],
        submitting: ['等待学校认证结果', '密码已经提交，请等待页面响应。', 'neutral'],
        cooldown: ['暂缓自动提交', '当前登录目标刚刚尝试过登录；“立即登录”可手动覆盖。', 'warning'],
        paused: ['本页自动登录已暂停', '刷新页面后会重新采用保存的设置。', 'warning'],
        captcha: [
          this.captchaReady ? '图形验证码已填写' : '需要填写图形验证码',
          this.captchaReady
            ? '请点击“立即登录”或学校登录按钮，脚本不会自动提交。'
            : '请在学校页面填写图片中的字符，再点击登录。',
          'warning',
        ],
        'sms-login': ['短信登录模式', '请在学校页面获取、填写短信验证码并登录。', 'warning'],
        'second-factor': ['需要完成二次验证', '请在学校页面填写短信验证码或完成其他二次认证。', 'warning'],
        'credential-error': ['账号或密码未通过', '已暂停本页，请检查保存的登录凭据。', 'danger'],
        'rate-limited': ['请求过于频繁', '已延长冷却时间，请稍后再试。', 'danger'],
        'service-error': ['认证服务暂时异常', '脚本不会继续重复提交。', 'danger'],
        corrupt: ['本地密码无法读取', '请重新保存登录凭据。', 'danger'],
        settings: ['设置模式', '当前页面只管理凭据，不会执行登录。', 'neutral'],
        saved: ['设置已保存', '本次不会自动提交；需要时请在登录页点击“立即登录”。', 'success'],
      };
      const [title, fallback, tone] = states[status] || states.waiting;
      this.currentStatus = status;
      const finalDetail = redactMessage(detail || fallback);
      if (this.statusText) this.statusText.textContent = title;
      if (this.statusDetail) this.statusDetail.textContent = finalDetail;
      if (this.panelStatus) this.panelStatus.textContent = title + '：' + finalDetail;
      if (this.statusDot) this.statusDot.dataset.tone = tone;
      this.setInteraction();
    }

    confirmClear() {
      if (this.clearButton.dataset.confirming === 'true') {
        clearTimeout(this.clearConfirmationTimer);
        delete this.clearButton.dataset.confirming;
        this.clearButton.textContent = '清除凭据';
        this.actions.clear?.();
        return;
      }
      this.clearButton.dataset.confirming = 'true';
      this.clearButton.textContent = '再次点击确认';
      this.clearConfirmationTimer = setTimeout(() => {
        delete this.clearButton.dataset.confirming;
        this.clearButton.textContent = '清除凭据';
      }, 3500);
    }
  }

  class AuthFlow {
    constructor(store, attempts, adapter, view) {
      this.store = store;
      this.attempts = attempts;
      this.adapter = adapter;
      this.view = view;
      this.profile = store.load();
      this.pendingTimer = null;
      this.pendingOrigin = '';
      this.observer = null;
      this.openedInitialPanel = false;
      this.failureState = '';
      this.manualRetryUntil = 0;
      this.retryEvaluationTimer = null;
      this.reservedContext = '';
      this.submittedContext = '';
    }

    start() {
      this.view.mount(this.profile);
      this.view.bind({
        login: () => this.requestLogin('manual'),
        pause: () => this.togglePause(),
        save: (data) => this.save(data),
        clear: () => this.clearCredentials(),
      });
      this.evaluate();

      let evaluationTimer = null;
      const scheduleEvaluation = () => {
        clearTimeout(evaluationTimer);
        evaluationTimer = setTimeout(() => this.evaluate(), 80);
      };
      const onCaptchaInput = (event) => {
        if (event.target === this.adapter.captchaInput()) scheduleEvaluation();
      };
      document.addEventListener('input', onCaptchaInput, true);
      document.addEventListener('change', onCaptchaInput, true);
      this.observer = new MutationObserver((mutations) => {
        const onlyAssistantChanges = mutations.every((mutation) => {
          const target =
            mutation.target instanceof Element
              ? mutation.target
              : mutation.target.parentElement;
          return target?.closest?.('#bitla-root');
        });
        if (onlyAssistantChanges) return;
        scheduleEvaluation();
      });
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'aria-selected', 'src'],
      });
    }

    evaluate() {
      const snapshot = this.adapter.snapshot();
      const kind = classifyPage(snapshot);
      this.view.setInteraction({
        hasCaptcha: kind === 'captcha' || snapshot.hasCaptcha,
        captchaReady: snapshot.captchaReady,
      });

      if (['password', 'captcha'].includes(kind)) {
        const credentials = this.store.credentials();
        if (credentials.corrupt || !credentials.username || !credentials.password) {
          this.cancelPending(false);
          this.view.renderStatus(credentials.corrupt ? 'corrupt' : 'needs-profile');
          if (!this.openedInitialPanel) {
            this.openedInitialPanel = true;
            setTimeout(() => this.view.openPanel(), 250);
          }
          return;
        }
      }
      if (kind === 'captcha') {
        const manualPending = this.pendingTimer && this.pendingOrigin !== 'auto' &&
          canStartPasswordAttempt(snapshot, this.pendingOrigin);
        const waitingForResult = snapshot.captchaReady &&
          this.submittedContext === this.adapter.context() &&
          (!['captcha', 'verification'].includes(snapshot.errorKind) ||
            Date.now() < this.manualRetryUntil);
        if (manualPending || waitingForResult) {
          this.view.renderStatus(this.pendingTimer ? 'queued' : 'submitting');
          return;
        }
      }
      if (['captcha', 'sms-login', 'second-factor'].includes(kind)) {
        this.manualRetryUntil = 0;
        this.cancelPending(false);
        this.submittedContext = '';
        this.failureState = '';
        this.view.renderStatus(kind, snapshot.message);
        return;
      }
      if (kind === 'credential-error') {
        if (Date.now() < this.manualRetryUntil) {
          this.view.renderStatus(this.pendingTimer ? 'queued' : 'submitting');
          return;
        }
        this.cancelPending(false);
        const context = this.adapter.context();
        this.submittedContext = '';
        this.failureState = kind;
        this.attempts.clear(context);
        this.attempts.setPaused(true);
        this.view.setInteraction({ paused: true });
        this.view.renderStatus(kind, snapshot.message);
        return;
      }
      if (kind === 'rate-limited') {
        this.cancelPending(false);
        const context = this.adapter.context();
        this.submittedContext = '';
        this.failureState = kind;
        this.attempts.record(context, RATE_LIMIT_COOLDOWN_MS, 'blocked');
        this.attempts.setPaused(true);
        this.view.setInteraction({ paused: true });
        this.view.renderStatus(kind, snapshot.message);
        return;
      }
      if (kind === 'service-error') {
        this.cancelPending(false);
        this.submittedContext = '';
        this.failureState = kind;
        this.attempts.setPaused(true);
        this.view.setInteraction({ paused: true });
        this.view.renderStatus(kind, snapshot.message);
        return;
      }
      if (kind !== 'password') {
        this.view.renderStatus('waiting');
        return;
      }

      if (this.attempts.isPaused()) {
        this.view.setInteraction({ paused: true });
        this.view.renderStatus(this.failureState || 'paused');
        return;
      }
      if (this.pendingTimer) {
        this.view.renderStatus('queued');
        return;
      }

      const context = this.adapter.context();
      if (this.submittedContext === context) {
        this.view.renderStatus('submitting');
        return;
      }
      if (!canAttempt(this.attempts.read(), context)) {
        this.view.renderStatus('cooldown');
        return;
      }

      if (this.profile.autoSubmit) this.requestLogin('auto');
      else this.view.renderStatus('ready');
    }

    requestLogin(origin) {
      if (this.pendingTimer) return;

      const snapshot = this.adapter.snapshot();
      if (!canStartPasswordAttempt(snapshot, origin)) {
        this.evaluate();
        return;
      }
      const context = this.adapter.context();
      if (origin === 'manual') {
        this.attempts.clear(context);
        this.attempts.setPaused(false);
        this.submittedContext = '';
        this.failureState = '';
      }
      if (origin !== 'auto') {
        this.manualRetryUntil =
          Date.now() + SUBMIT_DELAY_MS + MANUAL_RETRY_GRACE_MS;
      }
      const credentials = this.store.credentials();
      if (credentials.corrupt || !credentials.username || !credentials.password) {
        this.view.renderStatus(credentials.corrupt ? 'corrupt' : 'needs-profile');
        this.view.openPanel();
        return;
      }
      if (!this.attempts.reserve(context)) {
        this.view.renderStatus('cooldown');
        return;
      }
      this.reservedContext = context;
      if (!this.adapter.fillCredentials(credentials.username, credentials.password)) {
        this.attempts.release(context);
        this.reservedContext = '';
        this.manualRetryUntil = 0;
        this.view.renderStatus('waiting', '没有发现可见的账号密码表单。');
        return;
      }

      this.view.setInteraction({ pending: true, paused: false });
      this.view.renderStatus('queued');
      this.pendingOrigin = origin;
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.pendingOrigin = '';
        if (!this.attempts.ownsReservation(context)) {
          this.reservedContext = '';
          this.manualRetryUntil = 0;
          this.view.setInteraction({ pending: false });
          this.view.renderStatus('cooldown');
          return;
        }
        if (this.adapter.context() !== context ||
          !canStartPasswordAttempt(this.adapter.snapshot(), origin)) {
          this.cancelPending(false);
          this.evaluate();
          return;
        }
        if (!this.adapter.submit()) {
          this.attempts.release(context);
          this.reservedContext = '';
          this.manualRetryUntil = 0;
          this.view.setInteraction({ pending: false });
          this.view.renderStatus(
            'ready',
            '学校登录按钮尚未就绪，脚本没有点击；可稍后手动重试。'
          );
          return;
        }
        this.attempts.record(context);
        this.reservedContext = '';
        this.submittedContext = context;
        this.manualRetryUntil =
          origin !== 'auto' ? Date.now() + MANUAL_RETRY_GRACE_MS : 0;
        this.view.setInteraction({ pending: false });
        this.view.renderStatus('submitting');
        if (origin !== 'auto') {
          clearTimeout(this.retryEvaluationTimer);
          this.retryEvaluationTimer = setTimeout(() => {
            this.manualRetryUntil = 0;
            this.evaluate();
          }, MANUAL_RETRY_GRACE_MS);
        }
      }, SUBMIT_DELAY_MS);
    }

    cancelPending(pause = true) {
      this.manualRetryUntil = 0;
      this.pendingOrigin = '';
      clearTimeout(this.retryEvaluationTimer);
      this.retryEvaluationTimer = null;
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      if (this.reservedContext) {
        this.attempts.release(this.reservedContext);
        this.reservedContext = '';
      }
      if (pause) {
        this.attempts.setPaused(true);
        this.view.setInteraction({ pending: false, paused: true });
        this.view.renderStatus('paused');
      } else {
        this.view.setInteraction({ pending: false });
      }
    }

    togglePause() {
      if (this.pendingTimer) {
        this.cancelPending(true);
        return;
      }
      const paused = !this.attempts.isPaused();
      this.attempts.setPaused(paused);
      this.failureState = '';
      this.view.setInteraction({ paused });
      if (paused) this.view.renderStatus('paused');
      else if (this.profile.autoSubmit) this.requestLogin('resume');
      else this.evaluate();
    }

    save(data) {
      try {
        this.profile = this.store.applyForm(data);
        this.view.syncProfile(this.profile);
        this.view.renderStatus('saved');
        this.view.closePanel();
      } catch (error) {
        this.view.renderStatus('needs-profile', error.message || '设置保存失败。');
      }
    }

    clearCredentials() {
      this.cancelPending(false);
      this.profile = this.store.clearCredentials();
      this.attempts.setPaused(false);
      this.submittedContext = '';
      this.failureState = '';
      this.view.syncProfile(this.profile);
      this.view.renderStatus('needs-profile', '本地保存的学号和密码已经清除。');
    }

  }

  class SettingsFlow {
    constructor(store, view) {
      this.store = store;
      this.view = view;
      this.profile = store.load();
    }

    start() {
      this.view.mount(this.profile, { settingsOnly: true });
      this.view.bind({
        save: (data) => this.save(data),
        clear: () => this.clearCredentials(),
      });
      this.view.renderStatus('settings');
      this.view.openPanel();
    }

    save(data) {
      try {
        this.profile = this.store.applyForm(data);
        this.view.syncProfile(this.profile);
        this.view.renderStatus('saved');
      } catch (error) {
        this.view.renderStatus('needs-profile', error.message || '设置保存失败。');
      }
    }

    clearCredentials() {
      this.profile = this.store.clearCredentials();
      this.view.syncProfile(this.profile);
      this.view.renderStatus('needs-profile', '本地保存的学号和密码已经清除。');
    }
  }

  class App {
    constructor() {
      this.store = new ProfileStore();
      this.attempts = new AttemptStore();
      this.adapter = new AuthPageAdapter();
      this.view = null;
      this.flow = null;
    }

    start() {
      GM_registerMenuCommand('BIT 自动登录菜单', () => this.openFromMenu());
      if (!this.adapter.isAuthPage()) return;
      this.view = new AssistantView();
      this.flow = new AuthFlow(this.store, this.attempts, this.adapter, this.view);
      this.flow.start();
    }

    openFromMenu() {
      if (!this.view) {
        this.view = new AssistantView();
        this.flow = this.adapter.isAuthPage()
          ? new AuthFlow(this.store, this.attempts, this.adapter, this.view)
          : new SettingsFlow(this.store, this.view);
        this.flow.start();
      }
      this.view.openPanel();
    }
  }

  new App().start();
})();
