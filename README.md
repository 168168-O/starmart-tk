# StarMart-TK v2.0 · 只做 TikTok 的矩阵引擎

不是通用矩阵，把公众号 / 抖音 / 快手 / 小红书全砍掉，只留 TikTok 一条线，做深。

## 它到底比"通用版"强在哪

| 通用矩阵工具 | 这个 |
|---|---|
| 所有平台共用一个浏览器 | **一个账号一个独立浏览器配置目录**，cookie/localStorage/缓存物理隔离 |
| 所有账号直连本机 IP | **每个账号绑自己的代理**，代理断了账号自动跳过，不裸奔 |
| 多账号并发上传 | **强制串行**，同一时刻只有一个账号在动，降低关联风险 |
| 失败就失败 | **失败计数 + 一键重排**，日志按账号分开存 |
| 只能手动点 | **定时队列**，到点自己跑，人不在也行 |
| 数据要自己去后台看 | **本地看板**，粉丝/赞直接落库，历史可查 |

## 目录

```
starmart-tk/
├── main.js              Electron 主进程 + IPC
├── preload.js           安全桥（contextIsolation 开）
├── db.js                SQLite：accounts / tasks / stats
├── core/
│   ├── account.js       账号池（增删查、登录态检查）
│   ├── browser.js       指纹隔离 + 代理绑定 + 反自动化特征
│   ├── uploader.js      上传 → 转码等待 → 文案 → 发布
│   ├── scheduler.js     30 秒轮询，串行执行
│   └── stats.js         主页数据抓取
├── renderer/            界面（账号池 / 队列 / 看板 / 日志）
└── assets/              图标放这里
```

## 装依赖

```bash
cd starmart-tk
npm install          # 会自动装 Playwright 的 Chromium
```

> 国内网络慢就加镜像：
> ```bash
> npm config set registry https://registry.npmmirror.com
> set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
> npm install
> ```

## 跑起来（开发模式）

```bash
npm start
```

## 打包成 exe（给别人用）

```bash
npm run build
# 产物: dist/StarMart-TK-Setup-2.0.0.exe
```

## 第一次使用的顺序

1. **账号池 → 添加账号**：填备注名，`@handle` 填上（抓数据要用），有代理就填代理
2. 点 **检查登录** → 会弹出一个独立浏览器窗口，在里面扫码登录 TikTok，登录完关掉
3. **发布队列 → 选视频 → 填文案/话题 → 定时（留空=立即）→ 加入队列**
4. 到点它会自己开浏览器、上传、发布；也可以点 **立即跑** 手动触发
5. **数据看板 → 刷新** 抓粉丝和赞

## 几个关键设计（这些是"高端"的地方）

**① 指纹隔离**
每个账号一个 `profiles/<随机ID>/` 目录。cookie、localStorage、IndexedDB、缓存全部物理分开，平台侧看到的是两台不同电脑。

**② 代理绑定在账号上**
`core/browser.js` 里把代理、UA、时区、语言四项绑死在一个账号上。换代理不会串号，代理挂了会直接失败而不是走本机 IP。

**③ 反自动化特征清理**
启动参数 `--disable-blink-features=AutomationControlled`，关闭 `--enable-automation`，并注入脚本抹掉 `navigator.webdriver`。这是网页自动化最基本的一层。

**④ 人味延迟**
所有动作带 200~1600ms 随机停顿，文字逐字输入且每字 20~60ms 随机。机器味越少，风控越松。

**⑤ 串行调度**
`scheduler.js` 里有 `busy` 锁，同一时刻只有一个上传在跑。多账号并发是最容易被关联的特征。

**⑥ 数据本地化**
SQLite 存本地，日志按账号分文件（`logs/acc_<id>.log`），不上传任何服务器。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开就要求登录 | 账号 cookie 过期 | 点「检查登录」，在弹出的窗口里重新扫码 |
| 找不到上传控件 | TikTok 改了页面结构 | 改 `core/uploader.js` 顶部的 `SEL.file` |
| 找不到发布按钮 | 同上 | 改 `SEL.post` |
| 转码卡很久 | 视频太大 | 压到 1080p 以内，< 500MB |
| 代理连不上 | 格式写错 | 支持 `http://user:pass@ip:port` 和 `socks5://ip:port` |
| 想加视频号/抖音 | — | 这版故意不做，保持单一和稳定 |

## 已知边界

- 走的是**网页版 Studio**，不是 App 协议，所以平台页面一改就要跟着改选择器（`SEL` 里集中放着，改一处即可）
- 视频转码等待是**轮询判断**，不是平台回调，极端情况会多等一会儿
- 不支持"一条视频发多个账号"的批量分发，需要的话在队列里重复添加即可

## 版本

- 2.0.0  账号池 / 指纹隔离 / 代理绑定 / 串行队列 / 定时 / 数据看板 / 失败重试
