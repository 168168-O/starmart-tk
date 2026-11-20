"""
StarMart-TK Python 采集引擎 — SQLite 层
表结构跟 Electron 端完全一致，共用同一个 app.db
"""
from __future__ import annotations
import sqlite3
import time
from pathlib import Path

from .config import DB_FILE


_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, handle TEXT, profile TEXT NOT NULL,
  proxy TEXT, ua TEXT, tz TEXT, locale TEXT,
  status TEXT DEFAULT 'unknown', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL, video TEXT NOT NULL,
  caption TEXT, tags TEXT, schedule_at INTEGER,
  status TEXT DEFAULT 'pending', tries INTEGER DEFAULT 0,
  last_error TEXT, result_url TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0, shares INTEGER DEFAULT 0,
  followers INTEGER DEFAULT 0, captured_at INTEGER
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blogger_handle TEXT NOT NULL, account_id INTEGER,
  status TEXT DEFAULT 'pending',
  total_videos INTEGER DEFAULT 0, processed_videos INTEGER DEFAULT 0,
  total_comments INTEGER DEFAULT 0, unique_users INTEGER DEFAULT 0,
  last_error TEXT, created_at INTEGER, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  nickname TEXT, avatar TEXT, bio TEXT,
  followers INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, videos INTEGER DEFAULT 0,
  collected_from INTEGER,
  first_seen_at INTEGER, last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_collections_status ON collections(status);
CREATE INDEX IF NOT EXISTS idx_profiles_handle ON user_profiles(handle);
"""


def connect(db_path: Path | str = DB_FILE) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(_SCHEMA)
    return conn


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------- collections ----------
def col_add(conn: sqlite3.Connection, blogger: str, account_id: int | None = None) -> int:
    cur = conn.execute(
        "INSERT INTO collections (blogger_handle, account_id, status, created_at) VALUES (?, ?, 'pending', ?)",
        (blogger, account_id, now_ms()))
    conn.commit()
    return cur.lastrowid


def col_set_status(conn: sqlite3.Connection, col_id: int, status: str, error: str | None = None):
    conn.execute(
        "UPDATE collections SET status = ?, last_error = COALESCE(?, last_error), "
        "finished_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE finished_at END "
        "WHERE id = ?",
        (status, error, status, now_ms(), col_id))
    conn.commit()


def col_set_progress(conn: sqlite3.Connection, col_id: int, **kwargs):
    if not kwargs:
        return
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    conn.execute(f"UPDATE collections SET {sets} WHERE id = ?", (*kwargs.values(), col_id))
    conn.commit()


def col_get(conn: sqlite3.Connection, col_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM collections WHERE id = ?", (col_id,)).fetchone()
    return dict(row) if row else None


def col_all(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM collections ORDER BY id DESC").fetchall()]


# ---------- user_profiles ----------
def profile_upsert(conn: sqlite3.Connection, p: dict) -> bool:
    """handle 唯一键。True=新用户插入，False=已存在更新"""
    handle = p["handle"]
    now = now_ms()
    existing = conn.execute("SELECT id FROM user_profiles WHERE handle = ?", (handle,)).fetchone()
    if existing:
        conn.execute(
            """UPDATE user_profiles SET
               nickname = COALESCE(?, nickname),
               avatar   = COALESCE(?, avatar),
               bio      = COALESCE(?, bio),
               followers= COALESCE(?, followers),
               likes    = COALESCE(?, likes),
               videos   = COALESCE(?, videos),
               last_seen_at = ?
               WHERE handle = ?""",
            (p.get("nickname") or None, p.get("avatar") or None, p.get("bio") or None,
             p.get("followers"), p.get("likes"), p.get("videos"),
             now, handle))
        conn.commit()
        return False
    conn.execute(
        """INSERT INTO user_profiles
           (handle, nickname, avatar, bio, followers, likes, videos, collected_from, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (handle, p.get("nickname", ""), p.get("avatar", ""), p.get("bio", ""),
         p.get("followers", 0), p.get("likes", 0), p.get("videos", 0),
         p.get("collected_from"), now, now))
    conn.commit()
    return True


def profile_count(conn: sqlite3.Connection, collection_id: int | None = None) -> int:
    if collection_id:
        row = conn.execute("SELECT COUNT(*) c FROM user_profiles WHERE collected_from = ?", (collection_id,)).fetchone()
    else:
        row = conn.execute("SELECT COUNT(*) c FROM user_profiles").fetchone()
    return row["c"]


def profile_exists(conn: sqlite3.Connection, handle: str) -> bool:
    return conn.execute("SELECT 1 FROM user_profiles WHERE handle = ?", (handle,)).fetchone() is not None


def profile_all(conn: sqlite3.Connection, collection_id: int | None = None) -> list[dict]:
    sql = "SELECT * FROM user_profiles"
    args: tuple = ()
    if collection_id:
        sql += " WHERE collected_from = ?"
        args = (collection_id,)
    sql += " ORDER BY followers DESC"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def profile_distinct_handles(conn: sqlite3.Connection) -> set[str]:
    return {r["handle"] for r in conn.execute("SELECT handle FROM user_profiles").fetchall()}
