const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('../db');

/* 每个账号一个独立浏览器配置目录（cookie/localStorage/缓存全隔离）
   代理、UA、时区、语言全部绑在账号上，避免被平台串号识别 */
async function openAccount(acc) {
  const dir = path.join(db.DATA_DIR, 'profiles', acc.profile);
  fs.mkdirSync(dir, { recursive: true });

  const opts = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: acc.locale || 'en-US',
    timezoneId: acc.tz || 'America/New_York',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      `--lang=${acc.locale || 'en-US'}`
    ],
    ignoreDefaultArgs: ['--enable-automation']
  };

  if (acc.ua) opts.userAgent = acc.ua;
  if (acc.proxy) {
    const p = acc.proxy.trim();
    if (/^socks5:\/\//i.test(p)) opts.proxy = { server: p };
    else if (p.includes('@')) {
      const [cred, host] = p.split('@');
      const [user, pass] = cred.split(':');
      opts.proxy = { server: 'http://' + host, username: user, password: pass };
    } else opts.proxy = { server: 'http://' + p };
  }

  const ctx = await chromium.launchPersistentContext(dir, opts);

  // 抹掉最容易被检测的几个自动化特征
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (p) => (
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(p)
    );
  });

  ctx.on('page', (pg) => pg.setDefaultTimeout(60000));
  return ctx;
}

async function closeAccount(ctx) {
  try { await ctx.close(); } catch (_) {}
}

/* 人一样的随机停顿，别让所有动作都精确到毫秒 */
function human(ms = 800) {
  return new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * ms)));
}

module.exports = { openAccount, closeAccount, human };
