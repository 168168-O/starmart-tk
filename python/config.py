"""
StarMart-TK Python 采集引擎 — 配置 + 认证材料管理
cookie / 签名参数 / 代理都存 JSON，跟 Electron 部分解耦
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

# 数据目录：优先用 Electron 的同一个目录，没有就走 .data
if sys.platform == "win32":
    DEFAULT_DATA = Path(os.environ.get("APPDATA", "")) / "StarMart-TK"
elif sys.platform == "darwin":
    DEFAULT_DATA = Path.home() / "Library" / "Application Support" / "StarMart-TK"
else:
    DEFAULT_DATA = Path.cwd() / ".data"

DATA_DIR = Path(os.environ.get("STM_DATA_DIR", DEFAULT_DATA))
DATA_DIR.mkdir(parents=True, exist_ok=True)

PROFILES_DIR = DATA_DIR / "profiles"
LOGS_DIR = DATA_DIR / "logs"
COOKIE_FILE = DATA_DIR / "cookie.json"        # 用户 cookie + 签名参数
STATE_FILE  = DATA_DIR / "state.json"          # 运行时 checkpoint
DB_FILE     = DATA_DIR / "app.db"              # SQLite（和 Electron 共用）

for d in (PROFILES_DIR, LOGS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# TikTok 常用 API 端点（GraphQL）
API_ENDPOINTS = {
    "user_posts":    "https://www.tiktok.com/api/user/post/item_list/",      # 博主作品列表
    "video_comments":"https://www.tiktok.com/api/comment/list/",             # 视频评论
    "user_profile":  "https://www.tiktok.com/api/user/detail/",              # 用户主页详情
    "video_detail":  "https://www.tiktok.com/api/item/detail/",              # 视频详情
    "mstoken":       "https://www.tiktok.com/passport/web/get_mstoken/",     # 刷新 mstoken
}

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.tiktok.com",
    "Referer": "https://www.tiktok.com/",
    "Sec-Ch-Ua": '"Chromium";v="124", "Not-A.Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


class AuthState:
    """cookie + 签名参数的增删改查"""

    def __init__(self, path: Path = COOKIE_FILE):
        self.path = path
        self.data: dict = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {"cookie": "", "msToken": "", "X-Bogus": "", "_signature": "",
                "verifyFp": "", "a_bogus": ""}

    def save(self):
        self.path.write_text(json.dumps(self.data, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- cookie ----
    @property
    def cookie(self) -> str:
        return self.data.get("cookie", "")

    @cookie.setter
    def cookie(self, v: str):
        self.data["cookie"] = v or ""
        self.save()

    # ---- 签名参数 ----
    def update_signatures(self, **kwargs):
        for k, v in kwargs.items():
            if v is not None:
                self.data[k] = v
        self.save()

    # ---- 组装请求头 ----
    def headers(self, extra: dict | None = None) -> dict:
        h = dict(DEFAULT_HEADERS)
        if self.cookie:
            h["Cookie"] = self.cookie
        # 签名参数拼到 query 上（不在 header），这里先返回基础 headers
        if extra:
            h.update(extra)
        return h

    def has_cookie(self) -> bool:
        return bool(self.cookie)


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
