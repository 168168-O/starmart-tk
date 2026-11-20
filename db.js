const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/* DATA_DIR 解析优先级：
   1. 显式调用 setDataDir(path) 设的值
   2. CLI_DATA_DIR 环境变量（给脚本/CLI 用）
   3. Electron app.getPath('userData') + '/starmart-tk'
   4. 默认：process.cwd()/.data（最兜底） */
let _explicitDir = null;
function setDataDir(p) { _explicitDir = p; }
function _resolveDataDir() {
  if (_explicitDir) return _explicitDir;
  if (process.env.CLI_DATA_DIR) return process.env.CLI_DATA_DIR;
  try {
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'starmart-tk');
  } catch (_) { /* 非 Electron 环境忽略 */ }
  return path.join(process.cwd(), '.data');
}

let db = null;
let DATA_DIR = null;

function init() {
  DATA_DIR = _resolveDataDir();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
  db = new Database(path.join(DATA_DIR, 'app.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      handle TEXT,
      profile TEXT NOT NULL,
      proxy TEXT,
      ua TEXT,
      tz TEXT,
      locale TEXT,
      status TEXT DEFAULT 'unknown',
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      video TEXT NOT NULL,
      caption TEXT,
      tags TEXT,
      schedule_at INTEGER,
      status TEXT DEFAULT 'pending',
      tries INTEGER DEFAULT 0,
      last_error TEXT,
      result_url TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      followers INTEGER DEFAULT 0,
      captured_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_stats_acc ON stats(account_id);

    /* 采集任务：输入一个博主 handle，跑完他所有视频的评论 */
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blogger_handle TEXT NOT NULL,
      account_id INTEGER,
      status TEXT DEFAULT 'pending',   -- pending / running / done / failed
      total_videos INTEGER DEFAULT 0,
      processed_videos INTEGER DEFAULT 0,
      total_comments INTEGER DEFAULT 0,
      unique_users INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_collections_status ON collections(status);

    /* 采集到的评论区用户画像，去重（handle 唯一） */
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL UNIQUE,
      nickname TEXT,
      avatar TEXT,
      bio TEXT,
      followers INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      videos INTEGER DEFAULT 0,
      collected_from INTEGER,   -- 来自哪个 collection
      first_seen_at INTEGER,
      last_seen_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_handle ON user_profiles(handle);
  `);
  return db;
}

function get() { if (!db) init(); return db; }

const tasks = {
  all: () => get().prepare('SELECT * FROM tasks ORDER BY id DESC').all(),
  one: (id) => get().prepare('SELECT * FROM tasks WHERE id = ?').get(id),
  add: (t) => {
    const st = get().prepare(`INSERT INTO tasks (account_id, video, caption, tags, schedule_at, status, tries, created_at)
                              VALUES (@account_id, @video, @caption, @tags, @schedule_at, 'pending', 0, @now)`);
    const info = st.run({
      account_id: t.account_id, video: t.video, caption: t.caption || '',
      tags: t.tags || '', schedule_at: t.schedule_at || null, now: Date.now()
    });
    return { ok: true, id: info.lastInsertRowid };
  },
  remove: (id) => { get().prepare('DELETE FROM tasks WHERE id = ?').run(id); return { ok: true }; },
  byStatus: (s, limit = 50) => get().prepare('SELECT * FROM tasks WHERE status = ? LIMIT ?').all(s, limit),
  setStatus: (id, status, extra = {}) => {
    get().prepare('UPDATE tasks SET status = ?, tries = tries + ?, last_error = COALESCE(?, last_error), result_url = COALESCE(?, result_url) WHERE id = ?')
       .run(status, extra.incTries ? 1 : 0, extra.error || null, extra.url || null, id);
  },
  due: (now) => get().prepare(`SELECT * FROM tasks WHERE status = 'pending' AND (schedule_at IS NULL OR schedule_at <= ?) ORDER BY schedule_at LIMIT 5`).all(now)
};

const stats = {
  latest: (accountId) => get().prepare('SELECT * FROM stats WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId),
  insert: (s) => get().prepare(`INSERT INTO stats (account_id, views, likes, comments, shares, followers, captured_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(s.account_id, s.views | 0, s.likes | 0, s.comments | 0, s.shares | 0, s.followers | 0, Date.now()),
  overview: () => get().prepare(`
      SELECT a.id, a.name, a.handle,
             (SELECT views     FROM stats WHERE account_id = a.id ORDER BY id DESC LIMIT 1) AS views,
             (SELECT likes     FROM stats WHERE account_id = a.id ORDER BY id DESC LIMIT 1) AS likes,
             (SELECT followers FROM stats WHERE account_id = a.id ORDER BY id DESC LIMIT 1) AS followers,
             (SELECT captured_at FROM stats WHERE account_id = a.id ORDER BY id DESC LIMIT 1) AS captured_at
      FROM accounts a ORDER BY a.id`).all()
};

/* ---------- 采集任务 ---------- */
const collections = {
  all: () => get().prepare('SELECT * FROM collections ORDER BY id DESC').all(),
  one: (id) => get().prepare('SELECT * FROM collections WHERE id = ?').get(id),
  add: (blogger, accountId) => {
    const st = get().prepare(`INSERT INTO collections (blogger_handle, account_id, status, created_at)
                              VALUES (?, ?, 'pending', ?)`);
    const info = st.run(blogger, accountId || null, Date.now());
    return { ok: true, id: info.lastInsertRowid };
  },
  setProgress: (id, { processed_videos, total_comments, unique_users, total_videos }) => {
    const sets = []; const vals = [];
    if (processed_videos != null) { sets.push('processed_videos = ?'); vals.push(processed_videos); }
    if (total_comments   != null) { sets.push('total_comments   = ?'); vals.push(total_comments);   }
    if (unique_users     != null) { sets.push('unique_users     = ?'); vals.push(unique_users);     }
    if (total_videos     != null) { sets.push('total_videos     = ?'); vals.push(total_videos);     }
    vals.push(id);
    get().prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },
  setStatus: (id, status, extra = {}) => {
    get().prepare(`UPDATE collections SET status = ?, last_error = COALESCE(?, last_error),
                  finished_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE finished_at END
                  WHERE id = ?`)
       .run(status, extra.error || null, status, Date.now(), id);
  },
  remove: (id) => { get().prepare('DELETE FROM collections WHERE id = ?').run(id); return { ok: true }; },
  clear: () => {
    const tx = get().transaction(() => {
      get().prepare('DELETE FROM collections').run();
      get().prepare('DELETE FROM user_profiles').run();
    });
    tx();
    return { ok: true };
  }
};

/* ---------- 采集到的用户画像 ---------- */
const profiles = {
  all: (collectionId) => {
    if (collectionId) {
      return get().prepare('SELECT * FROM user_profiles WHERE collected_from = ? ORDER BY followers DESC').all(collectionId);
    }
    return get().prepare('SELECT * FROM user_profiles ORDER BY last_seen_at DESC').all();
  },
  count: (collectionId) => {
    if (collectionId) return get().prepare('SELECT COUNT(*) as c FROM user_profiles WHERE collected_from = ?').get(collectionId).c;
    return get().prepare('SELECT COUNT(*) as c FROM user_profiles').get().c;
  },
  /* upsert：handle 唯一键命中则更新头像/简介/粉丝/赞，同时刷新 last_seen_at */
  upsert: (p) => {
    const now = Date.now();
    const existing = get().prepare('SELECT id FROM user_profiles WHERE handle = ?').get(p.handle);
    if (existing) {
      get().prepare(`UPDATE user_profiles
                    SET nickname   = COALESCE(?, nickname),
                        avatar     = COALESCE(?, avatar),
                        bio        = COALESCE(?, bio),
                        followers  = COALESCE(?, followers),
                        likes      = COALESCE(?, likes),
                        videos     = COALESCE(?, videos),
                        last_seen_at = ?
                    WHERE id = ?`)
         .run(p.nickname || null, p.avatar || null, p.bio || null,
              p.followers || null, p.likes || null, p.videos || null,
              now, existing.id);
      return { id: existing.id, newUser: false };
    }
    const info = get().prepare(`INSERT INTO user_profiles
      (handle, nickname, avatar, bio, followers, likes, videos, collected_from, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.handle, p.nickname || '', p.avatar || '', p.bio || '',
           p.followers || 0, p.likes || 0, p.videos || 0,
           p.collected_from || null, now, now);
    return { id: info.lastInsertRowid, newUser: true };
  },
  removeByCollection: (collectionId) => {
    get().prepare('DELETE FROM user_profiles WHERE collected_from = ?').run(collectionId);
  }
};

module.exports = { init, get, tasks, stats, collections, profiles, DATA_DIR };
