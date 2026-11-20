"""
StarMart-TK — 浏览器采集引擎（页面导航 + 响应拦截模式）

原理：
  TikTok 的 /api/* 接口现在要求 a_bogus / X-Bogus 签名，直接 fetch 返回空 body。
  但 TikTok 自己页面加载时发出的请求是带合法签名的。
  所以我们：
    1. 导航到博主主页 / 视频页
    2. 用 page.on('response') 拦截 TikTok 自己发出的 API 响应
    3. 用户主页信息直接从 HTML 里的 __UNIVERSAL_DATA_FOR_REHYDRATION__ 解析
    4. 作品列表 / 评论列表靠滚动触发更多 API 调用，逐个拦截

  完全不碰签名算法，TikTok 改版也能跟着走。
"""
from __future__ import annotations
import json
import re
import time
import random
from typing import Any
from urllib.parse import urlencode

from .api_client import TikTokAPI


class BrowserTikTokAPI:
    """和 TikTokAPI 相同的方法签名，但数据来自页面导航 + 响应拦截"""

    def __init__(
        self,
        proxy: str | None = None,
        headless: bool = False,
        req_delay: tuple[float, float] = (0.4, 0.9),
        cookie_str: str = "",
    ):
        self.proxy = proxy
        self.headless = headless
        self.req_delay = req_delay
        self.cookie_str = cookie_str
        self._last_req = 0.0
        self._pw = None
        self._ctx = None
        self._page = None
        # 响应拦截缓存：endpoint -> list[response_body_dict]
        self._captured: dict[str, list[dict]] = {}

    # ---------- 生命周期 ----------
    def start(self, wait_login: bool = True, login_timeout: int = 300):
        from playwright.sync_api import sync_playwright
        from .config import PROFILES_DIR
        self._pw = sync_playwright().start()

        profile_dir = PROFILES_DIR / "browser_engine"
        profile_dir.mkdir(parents=True, exist_ok=True)

        launch_kwargs: dict = {
            "user_data_dir": str(profile_dir),
            "headless": self.headless,
            "viewport": {"width": 1366, "height": 900},
            "locale": "en-US",
            "timezone_id": "America/New_York",
            "args": ["--disable-blink-features=AutomationControlled",
                     "--no-first-run", "--no-default-browser-check"],
        }
        if self.proxy:
            launch_kwargs["proxy"] = _parse_proxy(self.proxy)
            print(f"🌐 浏览器引擎使用代理: {self.proxy}")

        self._ctx = self._pw.chromium.launch_persistent_context(**launch_kwargs)
        self._page = self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()

        # 注入 cookie（如果有）
        if self.cookie_str:
            self._inject_cookies(self.cookie_str)

        print("🚀 启动浏览器引擎（持久化登录态）...")
        for attempt in range(3):
            try:
                self._page.goto("https://www.tiktok.com/", wait_until="domcontentloaded", timeout=60_000)
            except Exception as e:
                print(f"⚠️ 首页加载异常（继续尝试）: {str(e)[:120]}")
            self._page.wait_for_timeout(3000)
            cur = self._page.url or ""
            if cur.startswith("chrome-error") or cur.startswith("about:blank"):
                if attempt < 2:
                    print(f"  🔄 页面处于错误页 ({cur[:60]})，重试加载首页...")
                    continue
                else:
                    raise RuntimeError(f"首页加载失败，连续3次都没到 TikTok（最后URL: {cur[:80]}）")
            if "tiktok.com" in cur:
                break

        if wait_login:
            self._wait_for_login(login_timeout)

        cookies = self._ctx.cookies()
        has_session = any(c.get("name") == "sessionid" for c in cookies)
        if not has_session:
            print("⚠️ 没有 sessionid cookie —— 可能没有真正登录过（匿名模式也能跑，但评论数受限）")

        print("✅ 采集环境就绪（页面导航 + 响应拦截模式）")

    def _inject_cookies(self, cookie_str: str):
        cookies = []
        for piece in cookie_str.split(";"):
            piece = piece.strip()
            if "=" in piece:
                k, v = piece.split("=", 1)
                cookies.append({"name": k.strip(), "value": v.strip(),
                                "domain": ".tiktok.com", "path": "/"})
        if cookies:
            try:
                self._ctx.add_cookies(cookies)
            except Exception:
                pass

    def _wait_for_login(self, timeout: int):
        try:
            for i in range(timeout // 5):
                try:
                    url = self._page.url or ""
                except Exception:
                    url = ""
                if "/login" not in url:
                    self._page.wait_for_timeout(2000)
                    try:
                        if "/login" not in (self._page.url or ""):
                            print("✅ 登录态 OK，继续采集")
                            return
                    except Exception:
                        pass
                if i == 0:
                    print("\n" + "=" * 55)
                    print("🔐 TikTok 弹了强制登录墙！请在弹出的浏览器窗口里登录")
                    print("   （手机扫码 / Google / 邮箱 都行）")
                    print(f"   登录成功后程序自动继续，最长等待 {timeout} 秒")
                    print("   ⚠️ 别关这个窗口，登录态会永久保存，下次免登录")
                    print("=" * 55 + "\n")
                self._page.wait_for_timeout(5000)
        except Exception as e:
            msg = str(e)
            if "Target" in msg or "closed" in msg.lower():
                raise RuntimeError("浏览器窗口被提前关掉了。请重跑一次，窗口弹出后**别关它**，完成登录即可。")
            raise

    def stop(self):
        try:
            if self._ctx:
                self._ctx.close()
        except Exception:
            pass
        try:
            if self._pw:
                self._pw.stop()
        except Exception:
            pass
        self._ctx = None
        self._page = None
        self._pw = None

    # ---------- 限速 ----------
    def _throttle(self):
        lo, hi = self.req_delay
        gap = lo + random.random() * (hi - lo)
        elapsed = time.time() - self._last_req
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_req = time.time()

    # ---------- 响应拦截 ----------
    def _setup_capture(self, endpoints: list[str]):
        """注册响应拦截器，把指定端点的 JSON 响应存到 self._captured"""
        self._captured = {ep: [] for ep in endpoints}

        def on_response(resp):
            url = resp.url
            for ep in endpoints:
                if ep in url:
                    try:
                        body = resp.text()
                        if body:
                            data = json.loads(body)
                            self._captured[ep].append(data)
                    except Exception:
                        pass
                    break

        self._page.on("response", on_response)
        return on_response

    def _remove_capture(self, handler):
        try:
            self._page.remove_listener("response", handler)
        except Exception:
            pass

    # ---------- 滚动加载 ----------
    def _scroll_load_more(self, max_scrolls: int = 10, wait_ms: int = 1500):
        """向下滚动页面，触发懒加载 API"""
        for i in range(max_scrolls):
            try:
                self._page.evaluate("window.scrollBy(0, window.innerHeight * 1.5)")
            except Exception:
                break
            self._page.wait_for_timeout(wait_ms)

    # ---------- 1. 博主详情（从页面 HTML 解析）----------
    def user_detail(self, sec_uid: str | None = None, unique_id: str | None = None) -> dict:
        if not unique_id:
            return {"__error__": "user_detail 需要 unique_id"}
        h = unique_id.lstrip("@")
        self._throttle()
        try:
            self._page.goto(f"https://www.tiktok.com/@{h}", wait_until="domcontentloaded", timeout=60_000)
        except Exception as e:
            return {"__error__": f"导航失败: {e}"}
        self._page.wait_for_timeout(2500)

        try:
            html = self._page.content()
        except Exception as e:
            return {"__error__": f"取页面内容失败: {e}"}

        data = self._parse_universal_data(html)
        if not data:
            return {"__error__": "页面未找到 __UNIVERSAL_DATA_FOR_REHYDRATION__"}

        user_info = self._find_user_info(data)
        if not user_info:
            return {"__error__": "页面数据里没找到 userInfo"}

        # 包装成和 parse_user_detail 兼容的结构
        return {"userInfo": user_info, "__status__": 200}

    @staticmethod
    def _parse_universal_data(html: str) -> dict | None:
        m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html, re.S)
        if not m:
            return None
        try:
            return json.loads(m.group(1).strip())
        except Exception:
            return None

    @staticmethod
    def _find_user_info(obj: Any, _path: str = "") -> dict | None:
        """递归找含 user + stats 的 userInfo 对象"""
        if isinstance(obj, dict):
            ui = obj.get("userInfo")
            if isinstance(ui, dict) and "user" in ui and "stats" in ui:
                return ui
            for v in obj.values():
                r = BrowserTikTokAPI._find_user_info(v)
                if r:
                    return r
        elif isinstance(obj, list):
            for v in obj:
                r = BrowserTikTokAPI._find_user_info(v)
                if r:
                    return r
        return None

    # ---------- 2. 博主作品列表（拦截 post/item_list 响应）----------
    def user_posts(self, sec_uid: str | None = None, unique_id: str | None = None,
                   count: int = 30, max_cursor: int = 0) -> dict:
        if not unique_id and not sec_uid:
            return {"__error__": "user_posts 需要 unique_id 或 sec_uid"}
        h = (unique_id or "").lstrip("@")
        self._throttle()

        ep = "/api/post/item_list/"
        handler = self._setup_capture([ep])
        try:
            self._page.goto(f"https://www.tiktok.com/@{h}", wait_until="domcontentloaded", timeout=60_000)
            # 等首屏作品 API 回来
            self._page.wait_for_timeout(4000)
            # 滚动加载更多
            self._scroll_load_more(max_scrolls=8, wait_ms=1500)
        finally:
            self._remove_capture(handler)

        items: list[dict] = []
        for resp in self._captured.get(ep, []):
            batch = (resp or {}).get("itemList") or (resp or {}).get("items") or (resp or {}).get("awemeList") or []
            items.extend(batch)

        # 去重
        seen = set()
        uniq = []
        for it in items:
            vid = str(it.get("id") or it.get("awemeId") or "")
            if vid and vid not in seen:
                seen.add(vid)
                uniq.append(it)
        return {"items": uniq, "hasMore": False, "maxCursor": 0, "__status__": 200}

    # ---------- 3. 视频评论（拦截 comment/list 响应）----------
    def video_comments(self, item_id: str, cursor: int = 0, count: int = 50,
                       unique_id: str | None = None) -> dict:
        if not item_id:
            return {"__error__": "video_comments 需要 item_id"}
        self._throttle()

        ep = "/api/comment/list/"
        handler = self._setup_capture([ep])
        try:
            # 视频页 URL 需要真实博主 handle，@_ 占位不会重定向
            handle = (unique_id or "tiktok").lstrip("@")
            url = f"https://www.tiktok.com/@{handle}/video/{item_id}"
            self._page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            # 等页面水合（不用 networkidle，TikTok 有持续请求）
            self._page.wait_for_timeout(5000)

            # 关键：滚动到评论区，触发评论 API 加载
            # 先尝试滚动到底部附近，再定位评论元素
            try:
                self._page.evaluate("""
                () => {
                    // 滚动到页面 2/3 处（评论区通常在下方）
                    window.scrollTo(0, document.body.scrollHeight * 0.6);
                }
                """)
                self._page.wait_for_timeout(2000)
                # 再定位评论元素滚动到可视区
                self._page.evaluate("""
                () => {
                    const els = document.querySelectorAll('[class*="comment"], [data-e2e*="comment"], [data-e2e="comment-item"]');
                    for (const el of els) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            el.scrollIntoView({behavior: 'instant', block: 'center'});
                            break;
                        }
                    }
                }
                """)
                self._page.wait_for_timeout(3000)
            except Exception:
                pass

            # 滚动加载更多评论
            self._scroll_load_more(max_scrolls=10, wait_ms=1500)
        finally:
            self._remove_capture(handler)

        comments: list[dict] = []
        for resp in self._captured.get(ep, []):
            batch = (resp or {}).get("comments") or (resp or {}).get("items") or []
            comments.extend(batch)

        # 去重
        seen = set()
        uniq = []
        for c in comments:
            cid = str(c.get("cid") or c.get("id") or "")
            if cid and cid not in seen:
                seen.add(cid)
                uniq.append(c)
        return {"comments": uniq, "hasMore": False, "cursor": 0, "__status__": 200}

    # ---------- 解析（复用 TikTokAPI 的静态方法）----------
    def parse_user_detail(self, data: dict) -> dict | None:
        return TikTokAPI.parse_user_detail(data)

    def parse_post_items(self, data: dict) -> list[dict]:
        return TikTokAPI.parse_post_items(data)

    def parse_comments(self, data: dict) -> list[dict]:
        return TikTokAPI.parse_comments(data)


def _build_path(path: str, params: dict) -> str:
    q = urlencode(params, safe=",")
    return f"{path}?{q}"


def _parse_proxy(url: str) -> dict:
    if not url:
        return {}
    u = url.strip()
    proxy_type = "http"
    if u.startswith("socks5://"):
        proxy_type = "socks5"
        u = u[len("socks5://"):]
    elif u.startswith("http://"):
        u = u[len("http://"):]
    elif u.startswith("https://"):
        u = u[len("https://"):]
    username = password = None
    if "@" in u:
        cred, host = u.split("@", 1)
        if ":" in cred:
            username, password = cred.split(":", 1)
    else:
        host = u
    result: dict = {"server": f"{proxy_type}://{host}"}
    if username:
        result["username"] = username
    if password:
        result["password"] = password
    return result
