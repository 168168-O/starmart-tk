const path = require('path');
const fs = require('fs');
const db = require('../db');
const { openAccount, closeAccount } = require('./browser');

const DATA_DIR = db.DATA_DIR;

function list() {
  return db.get().prepare('SELECT * FROM accounts ORDER BY id').all().map(a => ({
    ...a,
    tasks: db.get().prepare('SELECT COUNT(*) c FROM tasks WHERE account_id = ?').get(a.id).c,
    views: (db.stats.latest(a.id) || {}).views || 0
  }));
}

function add(data) {
  const name = (data.name || '').trim();
  if (!name) return { ok: false, msg: '账号名必填' };
  const handle = (data.handle || '').trim().replace(/^@/, '');
  const profile = `p${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const st = db.get().prepare(`INSERT INTO accounts (name, handle, profile, proxy, ua, tz, locale, status, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?)`);
  const info = st.run(name, handle, profile, data.proxy || null, data.ua || null,
                      data.tz || 'America/New_York', data.locale || 'en-US', Date.now());
  return { ok: true, id: info.lastInsertRowid };
}

function remove(id) {
  const acc = db.get().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) return { ok: false, msg: '账号不存在' };
  db.get().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  db.get().prepare('DELETE FROM tasks WHERE account_id = ?').run(id);
  const dir = profileDir(acc);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return { ok: true };
}

function profileDir(acc) {
  if (typeof acc === 'number') acc = db.get().prepare('SELECT * FROM accounts WHERE id = ?').get(acc);
  return path.join(DATA_DIR, 'profiles', acc.profile);
}

/* 打开一次账号，检查是否还处于登录态 */
async function checkLogin(id) {
  const acc = db.get().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) return { ok: false, msg: '账号不存在' };
  let ctx = null;
  try {
    ctx = await openAccount(acc);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.tiktok.com/tiktokstudio', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    const url = page.url();
    const logged = !/login|verify/i.test(url);
    db.get().prepare('UPDATE accounts SET status = ? WHERE id = ?').run(logged ? 'online' : 'offline', id);
    return { ok: true, logged, url };
  } catch (e) {
    db.get().prepare("UPDATE accounts SET status = 'error' WHERE id = ?").run(id);
    return { ok: false, msg: String(e.message || e) };
  } finally {
    if (ctx) await closeAccount(ctx);
  }
}

module.exports = { list, add, remove, checkLogin, profileDir };
