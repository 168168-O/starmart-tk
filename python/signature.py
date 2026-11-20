"""
StarMart-TK Python 采集引擎 — Cookie / 签名参数一次性采集

只跑这一次：
  1. Playwright 打开真实 Chrome 窗口（不是 headless）
  2. 你在里面扫码登录 TikTok
  3. 程序自动截获几个真实 API 请求，把 cookie + 签名参数保存到 cookie.json
  4. 后续全部用 curl_cffi 跑，不用再开浏览器

为什么要用 Playwright 抓？
  TikTok 现在对 TLS 指纹要求很严，curl_cffi 虽然能伪装 Chrome，
  但 cookie 必须是真实浏览器生成的（里面有 sessionid/sessionid_ss 等），
  登录态 cookie 人工复制很麻烦，Playwright 抓最稳。
"""
from __future__ import annotations
import sys
import time
from pathlib import Path

from .config import AuthState, DATA_DIR


def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
        return True
    except ImportError:
        return False


def _parse_proxy(url: str) -> dict:
    """把 http://user:pass@ip:port / socks5://ip:port 转成 Playwright 的 proxy dict"""
    if not url:
        return {}
    u = url.strip()
    # 从 URL 里拆 user/pass
    proxy_type = "http"
    if u.startswith("socks5://"):
        proxy_type = "socks5"
        u = u[len("socks5://"):]
    elif u.startswith("http://"):
        u = u[len("http://"):]
    elif u.startswith("https://"):
        u = u[len("https://"):]
    # 也支持写成 socks5:// 开头
    has_auth = "@" in u
    username = password = None
    if has_auth:
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


def capture_auth(headless: bool = False, wait_seconds: int = 120, proxy: str | None = None) -> bool:
    """
    弹出浏览器 → 等登录 → 自动保存 cookie + 签名参数
    wait_seconds: 扫码超时，默认 120 秒（2 分钟）
    proxy: 代理 URL，如 http://user:pass@ip:port 或 socks5://ip:port
    """
    if not _require_playwright():
        print("❌ playwright 未安装，请先执行:")
        print("   pip install playwright && playwright install chromium")
        return False

    from playwright.sync_api import sync_playwright

    auth = AuthState()
    captured: dict = {
        "cookie_parts": set(),
        "x_bogus": "",
        "ms_token": "",
        "_signature": "",
        "a_bogus": "",
        "verify_fp": "",
    }
    login_seen = False

    # 组装 launch 代理参数
    launch_kwargs: dict = {
        "headless": headless,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run", "--no-default-browser-check",
        ],
    }
    if proxy:
        launch_kwargs["proxy"] = _parse_proxy(proxy)
        print(f"🌐 使用代理: {proxy}")

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        ctx_kwargs: dict = {
            "viewport": {"width": 1440, "height": 900},
            "locale": "en-US",
            "timezone_id": "America/New_York",
        }
        # context 也支持代理（账号密码认证）
        if proxy and "@" in proxy:
            ctx_kwargs["proxy"] = _parse_proxy(proxy)
        ctx = browser.new_context(**ctx_kwargs)

        # 拦截所有请求，抓 cookie 和签名参数
        def on_request(req):
            url = req.url
            if "tiktok.com/api" in url or "tiktok.com/passport" in url:
                # 抓 cookie header
                hdr_cookie = req.headers.get("cookie", "")
                if hdr_cookie:
                    for piece in hdr_cookie.split(";"):
                        piece = piece.strip()
                        if piece:
                            captured["cookie_parts"].add(piece)
                # 抓 query 里的签名参数
                for key in ("X-Bogus", "a_bogus", "_signature", "msToken", "verifyFp"):
                    import re as _re
                    m = _re.search(rf"[?&]{key}=([^&]+)", url)
                    if m:
                        low = key.lower().replace("-", "_").replace("f", "f")
                        if low == "x_bogus": captured["x_bogus"] = m.group(1)
                        elif low == "a_bogus": captured["a_bogus"] = m.group(1)
                        elif low == "_signature": captured["_signature"] = m.group(1)
                        elif low == "mstoken": captured["ms_token"] = m.group(1)
                        elif low == "verifyfp": captured["verify_fp"] = m.group(1)

        def on_response(resp):
            url = resp.url
            # 登录成功后 resp 里一般有 session cookie 下发
            if "passport" in url or "login" in url:
                try:
                    for c in resp.context.cookies():
                        captured["cookie_parts"].add(f"{c['name']}={c['value']}")
                except Exception:
                    pass

        page = ctx.new_page()
        page.on("request", on_request)
        page.on("response", on_response)

        print("\n🌐 浏览器已启动，请在里面扫码或登录 TikTok")
        print("⏳ 等待登录中... (最长 %d 秒)" % wait_seconds)
        print("   登录完成后，页面能看到你的个人主页即可。\n")

        page.goto("https://www.tiktok.com/", wait_until="domcontentloaded", timeout=60_000)
        time.sleep(3)

        # 跳转个人主页触发真实 API 请求（抓签名参数）
        try:
            page.goto("https://www.tiktok.com/", wait_until="domcontentloaded", timeout=60_000)
        except Exception:
            pass

        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            # 检测是否登录：URL 是否包含 /login
            url = page.url if page else ""
            title = (page.title() or "") if page else ""
            is_login = "/login" in url.lower()
            if not is_login:
                # 再看页面里有没有 user 相关元素（更稳）
                try:
                    has_user = page.wait_for_selector(
                        '[data-e2e="user-avatar"], [data-e2e="profile-icon"]',
                        timeout=1500, state="attached"
                    )
                    if has_user:
                        login_seen = True
                        print("✅ 检测到登录态！", flush=True)
                        break
                except Exception:
                    pass
            time.sleep(2)

        if not login_seen:
            print("⚠️ 未检测到登录，仍会尝试保存当前 cookie（可能抓不全）", flush=True)

        # 再等几秒让 API 请求多发几条，抓完整签名
        time.sleep(5)

        # 保存 cookie（从 ctx.cookies() 直接拿最全）
        all_cookies = ctx.cookies()
        cookie_map: dict[str, str] = {}
        for c in all_cookies:
            cookie_map[c["name"]] = c["value"]
        # 合并拦截到的（可能多一些）
        for piece in captured["cookie_parts"]:
            if "=" in piece:
                k, v = piece.split("=", 1)
                cookie_map[k.strip()] = v.strip()
        auth.cookie = "; ".join(f"{k}={v}" for k, v in cookie_map.items())

        # 保存签名参数
        auth.update_signatures(
            msToken=captured["ms_token"] or None,
            **{k: (captured[v] or None) for k, v in [
                ("X-Bogus", "x_bogus"), ("_signature", "_signature"),
                ("a_bogus", "a_bogus"), ("verifyFp", "verify_fp"),
            ] if captured[v]},
        )

        browser.close()

    # 打印结果
    print("\n📋 采集结果:")
    print(f"   cookie   : {len(auth.cookie)} 字符")
    print(f"   msToken  : {'有' if auth.data.get('msToken') else '无'}")
    print(f"   X-Bogus  : {'有' if auth.data.get('X-Bogus') else '无'}")
    print(f"   签名参数存到了: {auth.path}")
    print(f"\n接下来你可以跑: python -m python.collector")
    return True


if __name__ == "__main__":
    print("=" * 50)
    print("TikTok 采集器 — 一次性抓 Cookie + 签名")
    print("=" * 50)
    headless = "--headless" in sys.argv
    timeout = 120
    for i, a in enumerate(sys.argv):
        if a == "--timeout" and i + 1 < len(sys.argv):
            timeout = int(sys.argv[i + 1])
    ok = capture_auth(headless=headless, wait_seconds=timeout)
    sys.exit(0 if ok else 1)
