const db = require('../db');
const { openAccount, closeAccount, human } = require('./browser');

/* 抓账号主页上的公开数字：粉丝、总点赞。单条视频数据在 Studio 里另抓。 */
async function refresh(accountId) {
  const acc = db.get().prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };

  let ctx = null;
  try {
    ctx = await openAccount(acc);
    const page = ctx.pages()[0] || await ctx.newPage();
    const handle = acc.handle ? acc.handle.replace(/^@/, '') : null;
    if (!handle) return { ok: false, msg: '这个账号没填 @handle，抓不到数据' };

    await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await human(3500);

    const num = async (sel) => {
      const el = await page.$(sel).catch(() => null);
      if (!el) return 0;
      const t = (await el.innerText().catch(() => '')).trim();
      return parseNum(t);
    };

    const followers = await num('[data-e2e="followers-count"]');
    const likes     = await num('[data-e2e="likes-count"]');

    db.stats.insert({ account_id: accountId, followers, likes, views: likes, comments: 0, shares: 0 });
    return { ok: true, followers, likes };
  } catch (e) {
    return { ok: false, msg: String(e.message || e) };
  } finally {
    if (ctx) await closeAccount(ctx);
  }
}

function parseNum(s) {
  if (!s) return 0;
  s = s.replace(/,/g, '').trim();
  const m = s.match(/^([\d.]+)\s*([KMB万亿])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  const mul = { K: 1e3, M: 1e6, B: 1e9, '万': 1e4, '亿': 1e8 }[unit] || 1;
  return Math.round(n * mul);
}

module.exports = { refresh };
