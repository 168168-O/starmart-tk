const fs = require('fs');
const path = require('path');
const db = require('../db');
const { openAccount, closeAccount, human } = require('./browser');

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';

/* 页面选择器会随版本变，这里给多套备选，命中任意一个就继续 */
const SEL = {
  file: ['input[type="file"]'],
  caption: [
    '[data-e2e="caption-input"]',
    'div[contenteditable="true"]',
    '.public-DraftEditor-content'
  ],
  post: [
    '[data-e2e="post-video-button"]',
    'button[data-e2e="post_video"]',
    'button:has-text("Post")',
    'button:has-text("发布")'
  ],
  uploadOk: [
    '[data-e2e="upload-success"]',
    '.upload-success',
    'text=上传成功',
    'text=Uploaded'
  ]
};

async function firstOf(page, list, opts) {
  for (const s of list) {
    try {
      const h = await page.waitForSelector(s, { timeout: opts && opts.timeout || 8000, state: 'attached' });
      if (h) return h;
    } catch (_) {}
  }
  return null;
}

function buildCaption(t) {
  const tags = (t.tags || '').split(/[,，\s]+/).filter(Boolean).map(x => x.startsWith('#') ? x : '#' + x);
  return [t.caption || '', tags.join(' ')].filter(Boolean).join('\n').slice(0, 2200);
}

/* 主流程：上传 -> 等转码 -> 填文案 -> 发布（或交给平台定时） */
async function run(task, log = () => {}) {
  const acc = db.get().prepare('SELECT * FROM accounts WHERE id = ?').get(task.account_id);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (!fs.existsSync(task.video)) return { ok: false, msg: '视频文件不在了: ' + task.video };

  const started = Date.now();
  let ctx = null;
  const say = (m) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`;
    log(line);
    fs.appendFileSync(path.join(db.DATA_DIR, 'logs', `acc_${acc.id}.log`), line + '\n');
  };

  try {
    db.tasks.setStatus(task.id, 'running');
    say(`打开浏览器  ${acc.name}`);
    ctx = await openAccount(acc);
    const page = ctx.pages()[0] || await ctx.newPage();

    say('进入上传页');
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await human(2500);

    if (/login/i.test(page.url())) {
      say('账号掉登录了，需要重新登录一次');
      db.tasks.setStatus(task.id, 'failed', { incTries: true, error: 'login required' });
      await page.waitForTimeout(120000);   // 留 2 分钟手工扫码
      throw new Error('账号未登录');
    }

    say('选择视频文件');
    const input = await firstOf(page, SEL.file, { timeout: 30000 });
    if (!input) throw new Error('找不到上传控件（页面结构变了）');
    await input.setInputFiles(task.video);
    await human(4000);

    say('等平台转码');
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000);
      const okEl = await firstOf(page, SEL.uploadOk, { timeout: 1200 }).catch(() => null);
      const uploading = await page.$('text=Processing, text=上传中, [role="progressbar"]');
      if (okEl && !uploading) { say('转码完成'); break; }
      if (i % 6 === 0) say(`  转码中… ${(i + 1) * 5}s`);
    }

    say('填写文案与话题');
    const editor = await firstOf(page, SEL.caption, { timeout: 20000 });
    if (editor) {
      await editor.click();
      await human(400);
      const text = buildCaption(task);
      if (text) {
        for (const ch of text) {
          await page.keyboard.type(ch, { delay: 20 + Math.floor(Math.random() * 40) });
        }
      }
      await human(1200);
    }

    say('点击发布');
    const post = await firstOf(page, SEL.post, { timeout: 20000 });
    if (!post) throw new Error('找不到发布按钮');
    await post.click();
    await human(6000);

    const url = page.url();
    db.tasks.setStatus(task.id, 'done', { url });
    say(`完成  用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
    return { ok: true, url };

  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    say('失败: ' + msg);
    db.tasks.setStatus(task.id, 'failed', { incTries: true, error: msg });
    return { ok: false, msg };
  } finally {
    if (ctx) await closeAccount(ctx);
  }
}

module.exports = { run };
