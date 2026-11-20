"""
StarMart-TK Python 采集引擎 — CLI 入口

用法:
  python -m python.cli auth            # 弹浏览器扫码抓 cookie + 签名（只跑一次）
  python -m python.cli run @handle    # 采集单个博主
  python -m python.cli batch list.txt  # 批量，文件里每行一个 handle 或 URL
  python -m python.cli retry          # 把所有 failed 的任务重新排队
  python -m python.cli status         # 查看所有采集任务
  python -m python.cli export --min-followers 10000  # 按条件筛选导出 CSV
  python -m python.cli clear          # 清空所有采集数据

环境变量:
  STM_DATA_DIR   自定义数据目录（默认跟 Electron 共用）
  STM_PROXY      HTTP/SOCKS5 代理（如 http://user:pass@ip:port）
  STM_IMPERSONATE  curl_cffi 伪装的浏览器（默认 chrome124）
"""
from __future__ import annotations
import argparse
import csv
import json
import sys
import time
from pathlib import Path

# 让 python 子包能被 -m 调用
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from python import config, db as stardb
from python.collector import Collector, normalize_handle
from python.api_client import TikTokAPI

_JSON_MODE = False  # --json 时切换为 NDJSON 输出，供 Electron 界面实时解析


def _log(msg: str):
    ts = time.strftime("%H:%M:%S")
    if _JSON_MODE:
        print(json.dumps({"type": "log", "ts": ts, "msg": msg}, ensure_ascii=False), flush=True)
    else:
        print(f"[{ts}] {msg}", flush=True)


def cmd_auth(args):
    """一次性抓 cookie + 签名参数"""
    from python import signature
    ok = signature.capture_auth(headless=False, wait_seconds=args.timeout, proxy=args.proxy)
    sys.exit(0 if ok else 1)


def _make_api(args, for_batch: bool = False):
    """根据 --http 开关造 API 客户端：默认浏览器签名引擎（稳定），--http 走纯 curl_cffi（快）"""
    if getattr(args, "http", False):
        auth = config.AuthState()
        if not auth.has_cookie() and not args.anon:
            _log("⚠️  没检测到 cookie，建议先跑 `python -m python.cli auth` 抓一次")
        return TikTokAPI(auth=auth, proxy=args.proxy, impersonate=args.impersonate,
                         req_delay=(args.min_delay, args.max_delay))
    from python.browser_fetch import BrowserTikTokAPI
    auth = config.AuthState()
    api = BrowserTikTokAPI(
        proxy=args.proxy,
        headless=getattr(args, "headless", False),
        req_delay=(args.min_delay, args.max_delay),
        cookie_str=auth.cookie if not args.anon else "",
    )
    api.start(login_timeout=600)
    return api


def cmd_run(args):
    """采集单个博主"""
    api = _make_api(args)
    try:
        conn = stardb.connect()
        c = Collector(api, conn, log=_log)
        res = c.run_blogger(
            args.input,
            max_videos=args.max_videos,
            max_comments_per_video=args.max_comments,
        )
    finally:
        if hasattr(api, "stop"):
            api.stop()
    if not res["ok"]:
        sys.exit(1)
    _log(f"✅ 完成: {res}")


def cmd_batch(args):
    """批量采集"""
    list_file = Path(args.list)
    if not list_file.exists():
        _log(f"❌ 文件不存在: {list_file}")
        sys.exit(1)

    handles = []
    for line in list_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        h = normalize_handle(line)
        if h:
            handles.append(h)
    _log(f"📋 待采集博主 {len(handles)} 个")

    api = _make_api(args, for_batch=True)
    conn = stardb.connect()
    c = Collector(api, conn, log=_log)

    done_count = fail_count = skip_count = 0
    try:
        for i, handle in enumerate(handles, 1):
            _log(f"\n{'#'*40}")
            _log(f"# {i}/{len(handles)}  {handle}")
            _log(f"{'#'*40}")
            res = c.run_blogger(
                handle,
                max_videos=args.max_videos,
                max_comments_per_video=args.max_comments,
            )
            if res.get("skipped"):
                skip_count += 1
            elif res["ok"]:
                done_count += 1
            else:
                fail_count += 1
    finally:
        if hasattr(api, "stop"):
            api.stop()

    _log(f"\n📊 批量完成：成功 {done_count}  跳过 {skip_count}  失败 {fail_count}")
    _log(f"   失败任务可以用 `python -m python.cli retry` 重跑")


def cmd_retry(args):
    """failed 的任务重跑"""
    conn = stardb.connect()
    rows = stardb.col_all(conn)
    failed = [r for r in rows if r["status"] == "failed"]
    if not failed:
        _log("没有失败的任务")
        return
    _log(f"找到 {len(failed)} 个失败任务")
    # 简单实现：把 status 清成 pending，batch 会自动处理（先跳过 done 的）
    for r in failed:
        stardb.col_set_status(conn, r["id"], "pending")
    _log("已全部重置为 pending，接下来跑 batch 就能补上")


def cmd_status(args):
    """查看任务状态"""
    conn = stardb.connect()
    rows = stardb.col_all(conn)
    if not rows:
        _log("还没有采集任务")
        return
    print(f"{'#':>4}  {'博主':<25} {'状态':<8} {'视频':>5} {'评论用户':>8} {'评论':>6} {'错误'}")
    print("-" * 80)
    for r in rows:
        err = (r["last_error"] or "")[:30]
        print(f"{r['id']:>4}  {r['blogger_handle']:<25} {r['status']:<8} "
              f"{r['processed_videos'] or 0:>4}/{r['total_videos'] or 0:>4} "
              f"{r['unique_users'] or 0:>8} {r['total_comments'] or 0:>6}  {err}")
    total_profiles = stardb.profile_count(conn)
    print(f"\n用户画像库总量: {total_profiles}")


def cmd_export(args):
    """筛选导出 CSV"""
    conn = stardb.connect()
    profiles = stardb.profile_all(conn, args.collection)

    # 筛选
    if args.min_followers is not None:
        profiles = [p for p in profiles if (p["followers"] or 0) >= args.min_followers]
    if args.max_followers is not None:
        profiles = [p for p in profiles if (p["followers"] or 0) <= args.max_followers]
    if args.has_bio:
        profiles = [p for p in profiles if p["bio"]]
    if args.no_bio:
        profiles = [p for p in profiles if not p["bio"]]
    if args.min_likes is not None:
        profiles = [p for p in profiles if (p["likes"] or 0) >= args.min_likes]

    out = Path(args.output or f"tiktok_profiles_{int(time.time())}.csv")
    header = ["handle", "nickname", "followers", "likes", "videos", "bio", "avatar"]
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for p in profiles:
            w.writerow([
                p["handle"], p["nickname"], p["followers"], p["likes"], p["videos"],
                p["bio"], p["avatar"],
            ])
    _log(f"✅ 已导出 {len(profiles)} 行 → {out.resolve()}")


def cmd_clear(args):
    """清空"""
    conn = stardb.connect()
    # 直接用 SQL DELETE
    conn.executescript("DELETE FROM collections; DELETE FROM user_profiles;")
    conn.commit()
    _log("✅ 已清空所有采集数据")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m python.cli",
        description="StarMart-TK Python 采集引擎",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # auth
    sp = sub.add_parser("auth", help="浏览器扫码抓 cookie + 签名（只跑一次）")
    sp.add_argument("--timeout", type=int, default=120, help="登录超时秒数")
    sp.add_argument("--proxy", default=None, help="代理 URL（被墙时必须用）")
    sp.set_defaults(func=cmd_auth)

    # run
    sp = sub.add_parser("run", help="采集单个博主")
    sp.add_argument("input", help="@handle 或完整 TikTok 主页链接")
    sp.add_argument("--max-videos", type=int, default=500)
    sp.add_argument("--max-comments", type=int, default=500)
    sp.add_argument("--proxy", default=None, help="代理 URL")
    sp.add_argument("--min-delay", type=float, default=0.3)
    sp.add_argument("--max-delay", type=float, default=0.8)
    sp.add_argument("--impersonate", default="chrome124")
    sp.add_argument("--anon", action="store_true", help="匿名模式（不使用 cookie）")
    sp.add_argument("--http", action="store_true", help="纯 HTTP 模式（快但可能被签名拦截，默认不用）")
    sp.add_argument("--headless", action="store_true", help="浏览器引擎无头运行（不弹窗口）")
    sp.add_argument("--json", action="store_true", help="NDJSON 输出（供 Electron 界面实时解析）")
    sp.set_defaults(func=cmd_run)

    # batch
    sp = sub.add_parser("batch", help="批量采集（文件每行一个 handle/URL）")
    sp.add_argument("list", help="handle 列表 txt 文件")
    sp.add_argument("--max-videos", type=int, default=500)
    sp.add_argument("--max-comments", type=int, default=500)
    sp.add_argument("--proxy", default=None)
    sp.add_argument("--min-delay", type=float, default=0.3)
    sp.add_argument("--max-delay", type=float, default=0.8)
    sp.add_argument("--impersonate", default="chrome124")
    sp.add_argument("--anon", action="store_true")
    sp.add_argument("--http", action="store_true")
    sp.add_argument("--headless", action="store_true")
    sp.add_argument("--json", action="store_true", help="NDJSON 输出（供 Electron 界面实时解析）")
    sp.set_defaults(func=cmd_batch)

    # retry / status / clear
    sp = sub.add_parser("retry", help="把 failed 任务重置为 pending")
    sp.set_defaults(func=cmd_retry)
    sp = sub.add_parser("status", help="查看任务状态")
    sp.set_defaults(func=cmd_status)
    sp = sub.add_parser("clear", help="清空所有采集数据")
    sp.set_defaults(func=cmd_clear)

    # export
    sp = sub.add_parser("export", help="按条件筛选导出 CSV")
    sp.add_argument("--collection", type=int, default=None, help="只导某个 collection_id 的数据")
    sp.add_argument("--min-followers", type=int, default=None)
    sp.add_argument("--max-followers", type=int, default=None)
    sp.add_argument("--min-likes", type=int, default=None)
    sp.add_argument("--has-bio", action="store_true", help="只要有简介的")
    sp.add_argument("--no-bio", action="store_true", help="只要没简介的")
    sp.add_argument("-o", "--output", default=None, help="输出 CSV 路径")
    sp.set_defaults(func=cmd_export)

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    global _JSON_MODE
    _JSON_MODE = getattr(args, "json", False)
    # 环境变量代理覆盖
    if not getattr(args, "proxy", None):
        ep = config.os.environ.get("STM_PROXY")
        if ep:
            args.proxy = ep
    if not getattr(args, "impersonate", None):
        ei = config.os.environ.get("STM_IMPERSONATE")
        if ei:
            args.impersonate = ei
    args.func(args)


if __name__ == "__main__":
    main()
