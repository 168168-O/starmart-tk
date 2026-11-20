"""
StarMart-TK Python 采集引擎 — TikTok API 客户端
使用 curl_cffi 伪装 Chrome TLS 指纹，比 requests 抗爬得多

签名策略：
  1. Playwright 启动一次浏览器，扫码登录，抓 cookie + 签名参数（X-Bogus / msToken / _signature）
  2. curl_cffi 带上 cookie + 伪装 UA 直接打 API
  3. 如果 cookie 过期 / 签名失效，CLI 会提示重新抓一次

实际 TikTok API 在 cookie 合法 + TLS 指纹匹配的前提下，
低频率的公开数据请求（博主主页、评论区）不一定需要 X-Bogus，
先试无签名请求能跑多远，跑不通再补签名层
"""
from __future__ import annotations
import re
import time
import random
from typing import Any, Iterable

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None  # 让模块能被 import，实际调用时再报错

from .config import AuthState, API_ENDPOINTS


def _extract_cover(item: dict) -> str:
    """从作品对象里提取封面图 URL，兼容多种结构"""
    video = item.get("video")
    if isinstance(video, dict):
        cover = video.get("cover") or video.get("originCover") or {}
        if isinstance(cover, dict):
            urls = cover.get("urlList") or cover.get("url_list") or []
            if urls:
                return urls[0]
    # 有些结构直接在 item 上
    covers = item.get("covers") or item.get("cover")
    if isinstance(covers, list) and covers:
        return covers[0] if isinstance(covers[0], str) else ""
    if isinstance(covers, dict):
        urls = covers.get("urlList") or covers.get("url_list") or []
        if urls:
            return urls[0]
    return ""


def _require_cffi():
    if curl_requests is None:
        raise RuntimeError(
            "curl_cffi 未安装。请执行:\n"
            "  pip install curl_cffi\n"
            "或者:\n"
            "  uv sync"
        )


class TikTokAPI:
    def __init__(
        self,
        auth: AuthState | None = None,
        proxy: str | None = None,
        impersonate: str = "chrome124",  # curl_cffi 伪装的浏览器版本
        req_delay: tuple[float, float] = (0.3, 0.8),
    ):
        _require_cffi()
        self.auth = auth or AuthState()
        self.proxy = proxy              # 如 "http://user:pass@ip:port"
        self.impersonate = impersonate
        self.req_delay = req_delay
        self._last_req = 0.0

    # ---- 限速 ----
    def _throttle(self):
        lo, hi = self.req_delay
        gap = lo + random.random() * (hi - lo)
        elapsed = time.time() - self._last_req
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_req = time.time()

    # ---- 核心请求 ----
    def _get(self, url: str, params: dict | None = None, extra_headers: dict | None = None) -> dict:
        self._throttle()
        headers = self.auth.headers(extra_headers)
        # 加一些 query 签名参数（如果有）
        params = dict(params or {})
        if self.auth.data.get("msToken"):
            params["msToken"] = self.auth.data["msToken"]
        params.setdefault("X-Bogus", self.auth.data.get("X-Bogus", ""))
        params.setdefault("_signature", self.auth.data.get("_signature", ""))
        params.setdefault("a_bogus", self.auth.data.get("a_bogus", ""))
        params.setdefault("verifyFp", self.auth.data.get("verifyFp", ""))

        try:
            resp = curl_requests.get(
                url,
                params=params,
                headers=headers,
                impersonate=self.impersonate,
                proxies={"http": self.proxy, "https": self.proxy} if self.proxy else None,
                timeout=15,
            )
            # 响应里可能有 set-cookie，合并回去（curl_cffi 的 Cookies 是 dict 风格）
            new_cookie = ""
            try:
                new_cookie = "; ".join(f"{k}={v}" for k, v in resp.cookies.items())
            except Exception:
                pass
            if new_cookie:
                # 只追加不覆盖已有 cookie（避免丢失登录态）
                self.auth.cookie = self._merge_cookies(self.auth.cookie, new_cookie)

            try:
                data = resp.json()
            except Exception:
                return {"__raw__": resp.text, "__status__": resp.status_code}
            data["__status__"] = resp.status_code
            return data
        except Exception as e:
            return {"__error__": str(e)}

    @staticmethod
    def _merge_cookies(old: str, new: str) -> str:
        if not new:
            return old
        old_parts = [p.strip() for p in old.split(";") if p.strip()]
        new_map: dict[str, str] = {}
        for p in new.split(";"):
            p = p.strip()
            if "=" in p:
                k, v = p.split("=", 1)
                new_map[k.strip()] = v.strip()
        merged: dict[str, str] = {}
        for p in old_parts:
            if "=" in p:
                k, v = p.split("=", 1)
                merged[k.strip()] = v.strip()
        merged.update(new_map)
        return "; ".join(f"{k}={v}" for k, v in merged.items())

    # ==================================================================
    # API 封装层
    # ==================================================================

    def user_posts(self, sec_uid: str | None = None, unique_id: str | None = None,
                   count: int = 30, max_cursor: int = 0) -> dict:
        """博主已发布作品列表。unique_id 就是 handle（不带 @）。"""
        params: dict[str, Any] = {
            "aid": "1988",
            "count": count,
            "offset": max_cursor,
            "source": "profile",
            "profile_tab": "post",
            "publish_video_strategy_type": "4",
        }
        if unique_id:
            params["uniqueId"] = unique_id.lstrip("@")
        if sec_uid:
            params["secUid"] = sec_uid
        params["device_id"] = str(random.randint(10_000_000_000_000_000, 99_999_999_999_999_999))
        return self._get(API_ENDPOINTS["user_posts"], params)

    def video_comments(self, item_id: str, cursor: int = 0, count: int = 50,
                       unique_id: str | None = None) -> dict:
        """视频评论（含主评论 + 回复）"""
        params = {
            "aid": "1988",
            "itemId": item_id,
            "cursor": cursor,
            "count": count,
            "device_id": str(random.randint(10_000_000_000_000_000, 99_999_999_999_999_999)),
            "enter_from": "tiktok_web",
            "channel": "channel_pc_web",
        }
        return self._get(API_ENDPOINTS["video_comments"], params)

    def user_detail(self, sec_uid: str | None = None, unique_id: str | None = None) -> dict:
        """用户主页详情（含头像、粉丝数、简介等）"""
        params: dict[str, Any] = {"aid": "1988"}
        if unique_id:
            params["uniqueId"] = unique_id.lstrip("@")
        if sec_uid:
            params["secUid"] = sec_uid
        params["device_id"] = str(random.randint(10_000_000_000_000_000, 99_999_999_999_999_999))
        return self._get(API_ENDPOINTS["user_profile"], params)

    # ==================================================================
    # 解析层：把原始 API JSON 提取成干净字段
    # ==================================================================

    @staticmethod
    def parse_user_detail(data: dict) -> dict | None:
        """从 user_detail 响应里取用户信息"""
        user = (data or {}).get("userInfo") or (data or {}).get("user")
        if not user:
            return None
        u = user.get("user", user)  # 嵌套一层
        stats = user.get("stats", {}) if isinstance(user, dict) else {}
        return {
            "unique_id":   u.get("uniqueId") or u.get("unique_id") or "",
            "handle":      "@" + (u.get("uniqueId") or u.get("unique_id") or ""),
            "sec_uid":     u.get("secUid") or u.get("sec_uid") or "",
            "nickname":    u.get("nickname") or "",
            "avatar":      u.get("avatarLarger") or u.get("avatar_medium") or u.get("avatarThumb") or "",
            "bio":         u.get("signature") or u.get("bio") or "",
            "followers":   stats.get("followerCount") or stats.get("follower_count") or 0,
            "likes":       stats.get("heartCount") or stats.get("heart_count") or stats.get("totalFavorited") or 0,
            "videos":      stats.get("videoCount") or stats.get("video_count") or 0,
            "verified":    bool(u.get("verified")),
        }

    @staticmethod
    def parse_post_items(data: dict) -> list[dict]:
        items = (data or {}).get("itemList") or (data or {}).get("items") or (data or {}).get("awemeList") or []
        out = []
        for it in items:
            if not it:
                continue
            v = it.get("id") or it.get("awemeId") or ""
            stats = it.get("stats") or {}
            out.append({
                "item_id": str(v),
                "desc":    it.get("desc") or "",
                "plays":   stats.get("playCount") or stats.get("play_count") or 0,
                "likes":   stats.get("diggCount") or stats.get("digg_count") or 0,
                "comments":stats.get("commentCount") or stats.get("comment_count") or 0,
                "shares":  stats.get("shareCount") or stats.get("share_count") or 0,
                "cover":   _extract_cover(it),
            })
        return out

    @staticmethod
    def parse_comments(data: dict) -> list[dict]:
        items = (data or {}).get("comments") or (data or {}).get("items") or []
        out = []

        def _comment(c: dict, parent_id: str | None = None):
            if not c:
                return
            user = c.get("user") or {}
            stats = c.get("stats") or {}
            out.append({
                "cid":       c.get("cid") or c.get("id") or "",
                "text":      c.get("text") or c.get("content") or "",
                "create_time": c.get("createTime") or c.get("create_time") or 0,
                "digg_count": stats.get("diggCount") or stats.get("digg_count") or c.get("digg_count") or 0,
                "parent_id": parent_id,
                # 用户信息
                "sec_uid":   user.get("secUid") or user.get("sec_uid") or "",
                "handle":    "@" + (user.get("uniqueId") or user.get("unique_id") or ""),
                "nickname":  user.get("nickname") or "",
                "avatar":    user.get("avatarLarger") or user.get("avatar_medium") or user.get("avatarThumb") or "",
            })
            # 子回复
            for reply in (c.get("reply_comment") or c.get("replies") or []):
                _comment(reply, parent_id=c.get("cid"))

        for c in items:
            _comment(c)
        return out
