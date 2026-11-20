const db = require('../db');
const { openAccount, closeAccount, human } = require('./browser');

/* ---------------- 选择器（多套备选，命中任意就继续） ---------------- */
const SEL = {
  /* 博主主页的视频卡片 */
  bloggerVideoCards: [
    '[data-e2e="user-post-item"] a',
    '[data-e2e="user-post-item"]',
    'div[class*="DivUserPostItem"] a',
    'a[href*="/video/"]'
  ],

  /* 评论区：一条主评论的容器 */
  commentContainer: [
    '[data-e2e="comment-item"]',
    'div[class*="DivCommentItemContainer"]',
    '[data-e2e="comment-level-1"]'
  ],

  /* 评论里的用户头像 */
  commentAvatar: [
    'img[alt*="profile"]',
    'img[data-e2e="comment-avatar"]',
    'div[class*="DivCommentAvatar"] img'
  ],

  /* 评论里的用户 handle（@xxx） */
  commentHandle: [
    '[data-e2e="comment-username"]',
    'a[href*="/@"]',
    'span[class*="SpanUserName"]'
  ],

  /* 评论里的昵称 */
  commentNick: [
    '[data-e2e="comment-nickname"]',
    'span[class*="SpanNickName"]'
  ],

  /* 展开回复的按钮，如 "View 3 replies" / "查看 3 条回复" */
  viewReplies: [
    '[data-e2e="view-replies-button"]',
    'button:has-text("View"):has-text("replies")',
    'button:has-text("查看"):has-text("回复")',
    'span:has-text("replies")',
    'span:has-text("回复")'
  ],

  /* 博主主页：头像 / 昵称 / handle / 简介 / 粉丝 / 点赞 / 视频数 */
  profileAvatar:   ['[data-e2e="user-avatar"] img', 'img[alt*="avatar"]', 'div[class*="Avatar"] img'],
  profileNickname: ['[data-e2e="user-title"]', 'h1[data-e2e*="title"]', 'h1'],
  profileHandle:   ['[data-e2e="user-subtitle"]', 'h2[data-e2e*="subtitle"]', 'span[data-e2e*="handle"]'],
  profileBio:      ['[data-e2e="user-bio"]', 'span[data-e2e*="bio"]'],
  profileFollowers: ['[data-e2e="followers-count"]', 'span[data-e2e*="followers"]'],
  profileLikes:     ['[data-e2e="likes-count"]', 'span[data-e2e*="likes"]'],
  profileVideos:    ['[data-e2e="videos-count"]', 'span[data-e2e*="video-count"]']
};

/* ---------------- 工具 ---------------- */
async function firstOf(page, list, opts = {}) {
  const timeout = opts.timeout ?? 6000;
  for (const s of list) {
    try {
      const h = await page.waitForSelector(s, { timeout, state: opts.state || 'attached' });
      if (h) return h;
    } catch (_) {}
  }
  return null;
}

/* 从一堆容器里，找到匹配 selector 的第一个内部元素 */
async function findInside(page, root, selectors) {
  for (const s of selectors) {
    try {
      const el = await root.$(s);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

/* 把 TikTok 头像 URL 里的低分辨率后缀替换成高清版
   规律：~c5_100x100.jpeg / ~tplv-obj...image.MIMEType / 或纯尺寸后缀
   也会尝试从 srcset 里挑最大的 */
function toHighResAvatar(url) {
  if (!url) return '';
  /* 如果有 srcset（在调用处处理），这里先处理单一 src 的情况 */
  let u = url;
  /* 去掉 TikTok CDN 的尺寸修饰后缀 */
  u = u.replace(/~c5_\d+x\d+\.\w+$/, '');           // ~c5_100x100.jpeg
  u = u.replace(/~\d+x\d+_\d+\.\w+$/, '');          // ~300x300_1.jpeg
  u = u.replace(/\/tos-maliva\/.*\/\d+x\d+_\d+/, ''); // /tos-maliva/.../300x300_1
  /* 有些 URL 结尾带 quality 参数 */
  u = u.replace(/&amp;q=\d+/, '').replace(/&q=\d+/, '');
  /* 追加一个大尺寸参数，TikTok CDN 支持 */
  if (!u.includes('?')) u += '?imageMogr2/format/jpeg/';
  return u;
}

/* 优先从 srcset 里挑分辨率最高的 URL，fallback 到高清化的 src */
function pickAvatar(imgEl) {
  if (!imgEl) return '';
  /* srcset 格式: "url1 100w, url2 300w, url3 600w" */
  const srcset = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset') || '';
  if (srcset) {
    const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
    let best = ''; let bestW = 0;
    for (const part of parts) {
      const m = part.match(/^(\S+)\s+(\d+)w$/);
      if (m && parseInt(m[2], 10) > bestW) { best = m[1]; bestW = parseInt(m[2], 10); }
    }
    if (best) return toHighResAvatar(best);
  }
  const src = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
  return toHighResAvatar(src);
}

function parseNum(s) {
  if (!s) return 0;
  s = String(s).replace(/,/g, '').trim();
  const m = s.match(/^([\d.]+)\s*([KMB万亿万])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  const mul = { K: 1e3, M: 1e6, B: 1e9, '万': 1e4, '亿': 1e8, '万': 1e4 }[unit] || 1;
  return Math.round(n * mul);
}

/* 从输入（可能是完整 URL、可能是 @handle、可能是纯数字视频 ID）解析出 handle */
function normalizeHandle(input) {
  if (!input) return null;
  input = input.trim();
  // URL：https://www.tiktok.com/@username/video/123456
  const m1 = input.match(/tiktok\.com\/@([\w.\-]+)/i);
  if (m1) return '@' + m1[1];
  // 直接 @handle
  if (/^@?[\w.\-]+$/.test(input)) return input.startsWith('@') ? input : '@' + input;
  return null;
}

/* ---------------- 步骤 1：收集博主所有视频链接 ---------------- */
async function collectBloggerVideos(page, handle, log) {
  const url = `https://www.tiktok.com/${handle.startsWith('@') ? handle : '@' + handle}`;
  log(`打开博主主页 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await human(3000);

  /* 滚到底，每次滚一屏，等加载；直到连续几次滚后高度不变 */
  const videos = new Set();   // 去重，存完整 video URL
  let lastHeight = 0;
  let stallCount = 0;
  const MAX_STALL = 5;

  for (let round = 0; round < 100; round++) {
    /* 从当前 DOM 里抓所有视频卡片的 href */
    const hrefs = await page.evaluate((SEL) => {
      const links = document.querySelectorAll(SEL.join(', '));
      const out = [];
      links.forEach(a => {
        let href = a.href || a.getAttribute('href') || '';
        const m = href.match(/\/video\/(\d+)/);
        if (m) out.push(m[0].startsWith('http') ? href : 'https://www.tiktok.com' + href);
      });
      return out;
    }, SEL.bloggerVideoCards);

    const before = videos.size;
    hrefs.forEach(h => videos.add(h));
    const added = videos.size - before;

    if (added > 0) {
      stallCount = 0;
      log(`  本轮发现 ${added} 条新视频，累计 ${videos.size} 条`);
    } else {
      stallCount++;
    }

    /* 滚到底 */
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await human(2200);

    const newH = await page.evaluate(() => document.body.scrollHeight);
    if (newH === lastHeight) stallCount++;
    lastHeight = newH;

    if (stallCount >= MAX_STALL) {
      log('  已滚到底，停止加载');
      break;
    }
  }

  log(`✅ 博主作品列表收集完成，共 ${videos.size} 条视频`);
  return [...videos];
}

/* ---------------- 步骤 2：进入单视频页面，滚评论区 ---------------- */
async function scrollCommentSection(page, maxComments, log) {
  const seenComments = new Set();   // 用 "handle + 评论内容前50字" 做唯一键，避免滚动时同一条重复统计
  let lastSeenSize = 0;
  let stallCount = 0;
  const MAX_STALL = 4;

  /* 先让页面完整加载 */
  await human(1500);

  for (let round = 0; round < 30; round++) {
    /* 抓当前所有主评论 */
    const items = await page.evaluate((SEL) => {
      const containers = document.querySelectorAll(SEL.commentContainer.join(', '));
      const results = [];
      containers.forEach(c => {
        /* handle */
        let handle = '';
        let nickname = '';
        let avatar = '';

        /* 找 handle */
        const hEl = c.querySelector(SEL.commentHandle.join(', '));
        if (hEl) {
          const href = hEl.getAttribute('href') || '';
          const hm = href.match(/\/@([\w.\-]+)/);
          if (hm) handle = '@' + hm[1];
          else {
            /* 可能直接是文本 */
            const txt = hEl.textContent.trim();
            if (txt.startsWith('@')) handle = txt;
          }
          if (!nickname && hEl.textContent.trim()) nickname = hEl.textContent.trim().replace(/^@/, '');
        }

        /* 找头像（优先 srcset 最大尺寸，再把 CDN 低分辨率后缀干掉） */
        const aEl = c.querySelector(SEL.commentAvatar.join(', '));
        if (aEl) {
          const _pick = (img) => {
            const _hi = (u) => (u || '').replace(/~c5_\d+x\d+\.\w+$/, '').replace(/~\d+x\d+_\d+\.\w+$/, '').replace(/&amp;q=\d+/, '').replace(/&q=\d+/, '');
            const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
            if (ss) {
              let best = '', bw = 0;
              ss.split(',').forEach(p => { const m = p.trim().match(/^(\S+)\s+(\d+)w$/); if (m && +m[2] > bw) { best = m[1]; bw = +m[2]; } });
              if (best) return _hi(best);
            }
            return _hi(img.getAttribute('src') || img.getAttribute('data-src') || '');
          };
          avatar = _pick(aEl);
        }

        /* 评论文本 */
        const textEl = c.querySelector('[data-e2e="comment-level-1"] > div:last-child, p, span');
        const text = textEl ? textEl.textContent.trim() : '';

        if (handle) {
          results.push({ handle, nickname, avatar, text });
        }
      });
      return results;
    }, SEL);

    /* 展开回复按钮（如果有） */
    await page.evaluate((SEL) => {
      const btns = document.querySelectorAll(SEL.viewReplies.join(', '));
      btns.forEach(b => {
        const txt = (b.textContent || '').toLowerCase();
        if (txt.includes('replies') || txt.includes('回复') || txt.includes('reply')) {
          b.click();
        }
      });
    }, SEL).catch(() => {});

    /* 去重汇总 */
    let newThisRound = 0;
    items.forEach(it => {
      const key = it.handle;
      if (!seenComments.has(key)) {
        seenComments.add(key);
        newThisRound++;
      }
    });

    /* 滚动评论区（不是整个页面，是评论面板） */
    await page.evaluate(() => {
      /* TikTok 的评论区可能是在一个固定高度的容器里 */
      const commentScrollers = document.querySelectorAll(
        '[data-e2e="comment-list-container"], ' +
        '[data-e2e="comments-container"], ' +
        'div[class*="DivCommentListContainer"], ' +
        'div[class*="DivCommentsContainer"]'
      );
      if (commentScrollers.length > 0) {
        commentScrollers.forEach(s => { s.scrollTop = s.scrollHeight; });
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
    }).catch(() => {});

    await human(1800);

    const currentSize = seenComments.size;
    if (currentSize === lastSeenSize) stallCount++;
    else { stallCount = 0; lastSeenSize = currentSize; }

    if (maxComments && currentSize >= maxComments) {
      log(`  已达到上限 ${maxComments}，停止采集本条视频`);
      break;
    }
    if (stallCount >= MAX_STALL) {
      log(`  评论区已到底（累计 ${currentSize} 个用户）`);
      break;
    }
  }

  return [...seenComments];  // 数组形式返回所有唯一 handle
}

/* ---------------- 步骤 3：进用户主页抓完整画像 ---------------- */
async function fetchUserProfile(page, handle, log) {
  const url = `https://www.tiktok.com/${handle.startsWith('@') ? handle : '@' + handle}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await human(1500);

    const data = await page.evaluate((SEL) => {
      const getText = (sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return '';
      };
      const getAttr = (sels, attr) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.getAttribute(attr)) return el.getAttribute(attr);
        }
        return '';
      };

      return {
        nickname:  getText(SEL.profileNickname),
        avatar:    getAttr(SEL.profileAvatar, 'src'),
        bio:       getText(SEL.profileBio),
        followers: getText(SEL.profileFollowers),
        likes:     getText(SEL.profileLikes),
        videos:    getText(SEL.profileVideos)
      };
    }, SEL);

    return {
      handle,
      nickname:  data.nickname || '',
      avatar:    data.avatar   || '',
      bio:       data.bio      || '',
      followers: parseNum(data.followers),
      likes:     parseNum(data.likes),
      videos:    parseNum(data.videos)
    };
  } catch (e) {
    return { handle, error: String(e.message || e).slice(0, 100) };
  }
}

/* ---------------- 主流程 ---------------- */
async function run({ input, accountId, maxPerVideo, onLog, onProgress }) {
  const log = (m) => { onLog && onLog(m); };

  /* 1. 解析 handle */
  const handle = normalizeHandle(input);
  if (!handle) return { ok: false, msg: '无法从输入解析出博主 handle（需要 URL、@handle 或 handle）' };

  /* 2. 选浏览器环境 */
  let ctx = null;
  let useAccount = null;
  if (accountId) {
    const acc = db.get().prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (acc) { useAccount = acc; ctx = await openAccount(acc); log(`复用账号 ${acc.name} 的浏览器环境`); }
  }
  if (!ctx) {
    /* 没账号也能跑，TikTok 主页评论区有部分公开可见 */
    const { chromium } = require('playwright');
    ctx = await chromium.launchPersistentContext(
      require('path').join(db.DATA_DIR, 'profiles', `public_${Date.now()}`),
      {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
        ignoreDefaultArgs: ['--enable-automation']
      }
    );
    log('未指定账号，使用匿名浏览器（评论可见数量可能受限）');
  }

  /* 3. 建 collection 任务 */
  const col = db.collections.add(handle, accountId || null);
  if (!col.ok) return { ok: false, msg: '创建采集任务失败' };
  db.collections.setStatus(col.id, 'running');
  const colId = col.id;
  const page = ctx.pages()[0] || await ctx.newPage();

  let totalComments = 0;
  let newUsers = 0;
  let errorMsg = null;

  try {
    /* 3.1 收集博主所有视频 */
    const videos = await collectBloggerVideos(page, handle, log);
    db.collections.setProgress(colId, { total_videos: videos.length });

    if (videos.length === 0) {
      errorMsg = '没抓到这个博主的任何视频（可能是私密账号或链接不对）';
      throw new Error(errorMsg);
    }

    /* 3.2 逐个视频采评论用户 */
    const allHandles = new Set();
    for (let vi = 0; vi < videos.length; vi++) {
      const vUrl = videos[vi];
      log(`\n━━━ 视频 ${vi + 1}/${videos.length} ━━━ ${vUrl.split('/video/')[1] || vUrl}`);

      try {
        await page.goto(vUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await human(2500);

        const handlesThisVideo = await scrollCommentSection(page, maxPerVideo || 500, log);
        handlesThisVideo.forEach(h => allHandles.add(h));
        totalComments += handlesThisVideo.length;
      } catch (ve) {
        log(`  ⚠️ 本条视频采集失败: ${ve.message || ve}`);
      }

      db.collections.setProgress(colId, {
        processed_videos: vi + 1,
        total_comments: totalComments
      });
      onProgress && onProgress({
        videos_done: vi + 1, videos_total: videos.length,
        comments_seen: totalComments, unique_users: allHandles.size
      });

      /* 视频之间稍作休息 */
      await human(800 + Math.floor(Math.random() * 1200));
    }

    log(`\n📋 视频遍历完成，累计看到 ${allHandles.size} 个不同评论用户`);

    /* 3.3 对每个 handle 进主页抓完整画像 */
    log('\n━━━ 开始采集用户画像 ━━━');
    let i = 0;
    for (const uHandle of allHandles) {
      i++;
      const existing = db.get().prepare('SELECT id FROM user_profiles WHERE handle = ?').get(uHandle);
      if (existing) {
        log(`  [${i}/${allHandles.size}] ${uHandle} — 已在库中，跳过`);
        db.profiles.upsert({ handle: uHandle, collected_from: colId });  // 刷新 last_seen_at
        continue;
      }

      const p = await fetchUserProfile(page, uHandle, log);
      if (p.error) {
        log(`  [${i}/${allHandles.size}] ${uHandle} — 主页访问失败: ${p.error}`);
        /* 即使主页访问失败，也把 handle 存下来，避免以后重采 */
        db.profiles.upsert({ handle: uHandle, collected_from: colId });
        await human(500);
        continue;
      }

      const r = db.profiles.upsert({ ...p, collected_from: colId });
      if (r.newUser) {
        newUsers++;
        log(`  [${i}/${allHandles.size}] ${uHandle} +${p.followers}F ${p.likes}♥ ${p.nickname ? '· ' + p.nickname : ''}`);
      } else {
        log(`  [${i}/${allHandles.size}] ${uHandle} — 更新`);
      }

      /* 画像之间稍作休息，别被反爬 */
      await human(400 + Math.floor(Math.random() * 800));

      /* 每 20 个用户回一次进度 */
      if (i % 20 === 0) {
        db.collections.setProgress(colId, { unique_users: newUsers + db.profiles.count(colId) - newUsers });
        onProgress && onProgress({
          profiles_done: i, profiles_total: allHandles.size,
          unique_users: db.profiles.count(colId)
        });
      }
    }

    /* 最终统计 */
    const finalCount = db.profiles.count(colId);
    db.collections.setProgress(colId, { unique_users: finalCount });
    db.collections.setStatus(colId, 'done');
    log(`\n🎉 采集任务 #${colId} 完成！`);
    log(`   博主: ${handle}`);
    log(`   视频数: ${videos.length}`);
    log(`   评论用户（去重后）: ${finalCount}`);

    return { ok: true, collectionId: colId, totalVideos: videos.length, uniqueUsers: finalCount };

  } catch (e) {
    errorMsg = String(e.message || e).slice(0, 300);
    db.collections.setStatus(colId, 'failed', { error: errorMsg });
    log(`❌ 采集失败: ${errorMsg}`);
    return { ok: false, msg: errorMsg, collectionId: colId };
  } finally {
    if (ctx) await closeAccount(ctx);
  }
}

module.exports = { run };
