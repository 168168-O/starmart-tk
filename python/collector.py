"""
StarMart-TK Python 采集引擎 — 核心逻辑

流程：
  对每个博主 handle:
    1. user_detail → 拿到 sec_uid（唯一稳定 ID，后面请求都用它）
    2. user_posts 翻页 → 收集该博主全部视频 item_id
    3. 对每个视频: video_comments 翻页 → 拿评论用户 sec_uid / handle
    4. 去重后 user_detail → 每个评论用户补完整画像

Checkpoint：每完成一个博主就落库状态，崩了重启时跳过 done 的
"""
from __future__ import annotations
import re
import sys
import time
import sqlite3
from typing import Callable
from pathlib import Path

from .config import AuthState, DATA_DIR, load_state, save_state
from .api_client import TikTokAPI
from . import db as stardb


def normalize_handle(input_str: str) -> str | None:
    if not input_str:
        return None
    s = input_str.strip()
    m = re.search(r"tiktok\.com/@([\w.\-]+)", s, re.I)
    if m:
        return "@" + m.group(1)
    if re.match(r"^@?[\w.\-]+$", s):
        return s if s.startswith("@") else "@" + s
    return None


def parse_num(s) -> int:
    if not s:
        return 0
    s = str(s).replace(",", "").strip()
    m = re.match(r"^([\d.]+)\s*([KMB万亿万])?", s, re.I)
    if not m:
        return 0
    n = float(m.group(1))
    unit = (m.group(2) or "").upper()
    mul = {"K": 1e3, "M": 1e6, "B": 1e9, "万": 1e4, "亿": 1e8}.get(unit, 1)
    return int(n * mul)


class Collector:
    def __init__(
        self,
        api: TikTokAPI,
        conn: sqlite3.Connection,
        log: Callable[[str], None] | None = None,
    ):
        self.api = api
        self.conn = conn
        self.log = log or (lambda m: print(m, flush=True))

    # ==================================================================
    # 1. 博主详情（拿 sec_uid + 基础信息）
    # ==================================================================
    def fetch_blogger(self, handle: str) -> dict | None:
        h = handle.lstrip("@")
        data = self.api.user_detail(unique_id=h)
        if "__error__" in data:
            self.log(f"  ❌ 博主详情请求失败: {data['__error__']}")
            return None
        if data.get("__status__", 200) != 200:
            self.log(f"  ⚠️ 博主详情 HTTP {data.get('__status__')}")
        user = TikTokAPI.parse_user_detail(data)
        if not user:
            self.log(f"  ❌ 博主详情解析失败，原始 keys: {list(data.keys())[:10]}")
            return None
        self.log(f"  博主: {user['handle']} {user['nickname']} · {user['followers']}F {user['likes']}♥ {user['videos']}v")
        return user

    # ==================================================================
    # 2. 博主全部作品（翻页直到没有更多）
    # ==================================================================
    def collect_blogger_videos(self, blogger: dict, max_videos: int = 500) -> list[dict]:
        sec_uid = blogger.get("sec_uid")
        unique_id = blogger.get("unique_id")
        cursor = 0
        all_items: list[dict] = []
        pages = 0
        while True:
            pages += 1
            data = self.api.user_posts(sec_uid=sec_uid, unique_id=unique_id,
                                       count=30, max_cursor=cursor)
            items = TikTokAPI.parse_post_items(data)
            all_items.extend(items)
            self.log(f"  📄 作品页 {pages}: +{len(items)} 条，累计 {len(all_items)}")
            if len(all_items) >= max_videos:
                all_items = all_items[:max_videos]
                self.log(f"  ✅ 达到上限 {max_videos}，停止翻页")
                break
            # 停止条件：cursor 没增长 / 没有 items
            new_cursor = (data or {}).get("maxCursor", 0) or (data or {}).get("max_cursor", 0) or 0
            has_more = (data or {}).get("hasMore") or (data or {}).get("has_more")
            if not items:
                self.log("  ✅ 作品列表已到底（返回空）")
                break
            if new_cursor == cursor or not has_more:
                self.log("  ✅ 作品列表已到底（cursor 不再前进）")
                break
            cursor = new_cursor
        self.log(f"  📦 共收集 {len(all_items)} 条作品")
        return all_items

    # ==================================================================
    # 3. 单视频评论区（翻页 + 递归子回复）
    # ==================================================================
    def collect_video_comments(self, item_id: str, max_comments: int = 500,
                               unique_id: str | None = None) -> list[dict]:
        cursor = 0
        all_comments: list[dict] = []
        pages = 0
        seen_handles: set[str] = set()

        while True:
            pages += 1
            data = self.api.video_comments(item_id, cursor=cursor, count=50,
                                           unique_id=unique_id)
            comments = TikTokAPI.parse_comments(data)
            for c in comments:
                h = c["handle"]
                if h and h not in seen_handles:
                    seen_handles.add(h)
                    all_comments.append(c)
            self.log(f"    💬 评论页 {pages}: +{len(comments)} 条，累计唯一用户 {len(seen_handles)}")

            if len(all_comments) >= max_comments:
                self.log(f"    ✅ 达到单视频上限 {max_comments}")
                break

            new_cursor = (data or {}).get("cursor", 0) or (data or {}).get("maxCursor", 0) or 0
            has_more = (data or {}).get("hasMore") or (data or {}).get("has_more")
            if not comments:
                self.log("    ✅ 评论已到底（返回空）")
                break
            if new_cursor == cursor or not has_more:
                self.log("    ✅ 评论已到底（cursor 不再前进）")
                break
            cursor = new_cursor

        return all_comments

    # ==================================================================
    # 4. 批量抓完整用户画像
    # ==================================================================
    def enrich_profiles(self, handles: list[str], collection_id: int) -> int:
        """
        对评论里出现过的 handle 批量抓完整画像（头像/粉丝/简介等）。
        已在库中的跳过，返回本次新写入的数量。
        """
        new_count = 0
        total = len(handles)
        for i, handle in enumerate(handles, 1):
            h = handle.lstrip("@")
            # 已存在 → 只刷新 last_seen_at
            if stardb.profile_exists(self.conn, handle):
                stardb.profile_upsert(self.conn, {
                    "handle": handle, "collected_from": collection_id
                })
                continue

            data = self.api.user_detail(unique_id=h)
            user = TikTokAPI.parse_user_detail(data)
            if not user:
                self.log(f"    ⚠️  [{i}/{total}] {handle} — 画像请求失败，仍存一条空记录")
                stardb.profile_upsert(self.conn, {
                    "handle": handle, "collected_from": collection_id
                })
                continue

            inserted = stardb.profile_upsert(self.conn, {
                "handle": user["handle"],
                "nickname": user["nickname"],
                "avatar": user["avatar"],
                "bio": user["bio"],
                "followers": user["followers"],
                "likes": user["likes"],
                "videos": user["videos"],
                "collected_from": collection_id,
            })
            if inserted:
                new_count += 1
                bar = "█" * int(i / total * 20) + "░" * (20 - int(i / total * 20))
                self.log(f"    [{bar}] {i}/{total} {handle} +{user['followers']}F {user['likes']}♥  NEW")
            else:
                self.log(f"    [{bar}] {i}/{total} {handle} UPDATE")

            # 每 50 个刷一次进度
            if i % 50 == 0:
                stardb.col_set_progress(
                    self.conn, collection_id,
                    unique_users=stardb.profile_count(self.conn, collection_id)
                )

        return new_count

    # ==================================================================
    # 单博主完整采集
    # ==================================================================
    def run_blogger(
        self,
        handle: str,
        max_videos: int = 500,
        max_comments_per_video: int = 500,
    ) -> dict:
        h = normalize_handle(handle)
        if not h:
            return {"ok": False, "msg": f"无法解析 handle: {handle}"}

        self.log(f"\n{'='*60}")
        self.log(f"🎯 开始采集博主: {h}")
        self.log(f"{'='*60}")

        # checkpoint：查有没有在采或采过的
        existing = self.conn.execute(
            "SELECT * FROM collections WHERE blogger_handle = ? ORDER BY id DESC LIMIT 1", (h,)
        ).fetchone()
        if existing and existing["status"] == "done":
            self.log(f"⏭️  已存在完成记录 #{existing['id']}，跳过（如需重采先清空）")
            return {"ok": True, "collection_id": existing["id"], "skipped": True}

        col_id = stardb.col_add(self.conn, h)
        stardb.col_set_status(self.conn, col_id, "running")

        try:
            blogger = self.fetch_blogger(h)
            if not blogger:
                stardb.col_set_status(self.conn, col_id, "failed", error="博主详情获取失败")
                return {"ok": False, "msg": "博主详情获取失败", "collection_id": col_id}

            videos = self.collect_blogger_videos(blogger, max_videos=max_videos)
            stardb.col_set_progress(self.conn, col_id, total_videos=len(videos))
            if not videos:
                stardb.col_set_status(self.conn, col_id, "failed", error="博主没有可访问的视频")
                return {"ok": False, "msg": "没有视频", "collection_id": col_id}

            # 3. 逐个视频抓评论
            all_handles: set[str] = set()
            total_comments = 0
            for i, v in enumerate(videos, 1):
                self.log(f"\n━━━ 视频 {i}/{len(videos)}  id={v['item_id']}  {v.get('desc','')[:40]}")
                try:
                    comments = self.collect_video_comments(
                        v["item_id"], max_comments=max_comments_per_video,
                        unique_id=blogger.get("unique_id"),
                    )
                    total_comments += len(comments)
                    for c in comments:
                        if c["handle"]:
                            all_handles.add(c["handle"])
                except Exception as e:
                    self.log(f"    ⚠️ 本条视频采集异常: {e}")

                stardb.col_set_progress(
                    self.conn, col_id,
                    processed_videos=i,
                    total_comments=total_comments,
                )

            self.log(f"\n📋 视频遍历完成，评论用户去重后 {len(all_handles)} 个")

            # 4. 抓完整画像
            self.log("━━━ 开始采集用户画像 ━━━")
            new_count = self.enrich_profiles(list(all_handles), col_id)

            unique_users = stardb.profile_count(self.conn, col_id)
            stardb.col_set_progress(self.conn, col_id, unique_users=unique_users)
            stardb.col_set_status(self.conn, col_id, "done")

            self.log(f"\n🎉 #{col_id} 完成！视频 {len(videos)}  评论用户 {unique_users}（新 +{new_count}）")
            return {"ok": True, "collection_id": col_id,
                    "videos": len(videos), "unique_users": unique_users, "new_profiles": new_count}

        except Exception as e:
            err = str(e)[:300]
            stardb.col_set_status(self.conn, col_id, "failed", error=err)
            self.log(f"❌ 采集失败: {err}")
            return {"ok": False, "msg": err, "collection_id": col_id}
