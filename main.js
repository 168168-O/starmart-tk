const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const accounts = require('./core/account');
const uploader = require('./core/uploader');
const scheduler = require('./core/scheduler');
const stats = require('./core/stats');

// Python 采集引擎路径（可用 STM_PYTHON 环境变量覆盖，默认走 PATH 里的 python）
const PYTHON = process.env.STM_PYTHON || 'python';

let collectProc = null;  // 当前正在跑的 Python 采集进程
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 1080, minHeight: 700,
    backgroundColor: '#0e1116',
    title: '达货TK矩阵',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setMenuBarVisibility(false);
}

app.whenReady().then(async () => {
  db.init();
  createWindow();
  scheduler.start((payload) => win && win.webContents.send('scheduler:event', payload));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { scheduler.stop(); if (process.platform !== 'darwin') app.quit(); });

/* ---------------- IPC: 账号 ---------------- */
ipcMain.handle('account:list', () => accounts.list());
ipcMain.handle('account:add', async (_e, data) => accounts.add(data));
ipcMain.handle('account:remove', (_e, id) => accounts.remove(id));
ipcMain.handle('account:check', async (_e, id) => accounts.checkLogin(id));
ipcMain.handle('account:profileDir', (_e, id) => accounts.profileDir(id));

/* ---------------- IPC: 任务 ---------------- */
ipcMain.handle('task:list', () => db.tasks.all());
ipcMain.handle('task:add', (_e, t) => db.tasks.add(t));
ipcMain.handle('task:remove', (_e, id) => db.tasks.remove(id));
ipcMain.handle('task:pickVideo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择视频',
    filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv'] }],
    properties: ['openFile', 'multiSelections']
  });
  return r.canceled ? [] : r.filePaths;
});

/* ---------------- IPC: 执行 ---------------- */
ipcMain.handle('run:now', async (_e, taskId) => {
  const t = db.tasks.one(taskId);
  if (!t) return { ok: false, msg: '任务不存在' };
  return uploader.run(t, (log) => win.webContents.send('run:log', log));
});
ipcMain.handle('run:retryFailed', async () => {
  const list = db.tasks.byStatus('failed');
  for (const t of list) db.tasks.setStatus(t.id, 'pending');
  return { ok: true, count: list.length };
});

/* ---------------- IPC: 数据 ---------------- */
ipcMain.handle('stats:refresh', async (_e, accountId) => stats.refresh(accountId));
ipcMain.handle('stats:get', (_e, accountId) => db.stats.latest(accountId));
ipcMain.handle('stats:overview', () => db.stats.overview());

/* ---------------- IPC: 采集 ---------------- */
ipcMain.handle('collection:list', () => db.collections.all());
ipcMain.handle('collection:remove', (_e, id) => {
  db.profiles.removeByCollection(id);
  return db.collections.remove(id);
});
ipcMain.handle('collection:clear', () => db.collections.clear());
ipcMain.handle('collection:profiles', (_e, collectionId) => db.profiles.all(collectionId));
ipcMain.handle('collection:exportCsv', async (_e, collectionId) => {
  const rows = db.profiles.all(collectionId);
  if (!rows.length) return { ok: false, msg: '没有数据' };
  const target = await dialog.showSaveDialog(win, {
    title: '导出 CSV',
    defaultPath: `tiktok_profiles_${collectionId}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (target.canceled) return { ok: false, msg: '已取消' };
  const header = ['handle', 'nickname', 'followers', 'likes', 'videos', 'avatar', 'bio'];
  const lines = [header.join(',')];
  rows.forEach(r => {
    const esc = (v) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    };
    lines.push([r.handle, esc(r.nickname), r.followers, r.likes, r.videos, esc(r.avatar), esc(r.bio)].join(','));
  });
  fs.writeFileSync(target.filePath, '\uFEFF' + lines.join('\n'), 'utf8');
  return { ok: true, path: target.filePath, count: rows.length };
});
ipcMain.handle('collection:run', async (_e, opts) => {
  if (collectProc) return { ok: false, msg: '已有采集任务在跑，请先停止' };
  const input = (opts.input || '').trim();
  if (!input) return { ok: false, msg: '博主链接或 handle 不能为空' };

  // 从输入里区分单个 vs 批量（多行 / 逗号分隔 → 写临时 txt 走 batch）
  const lines = input.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const isBatch = lines.length > 1;

  const args = ['-m', 'python.cli'];
  let tempList = null;
  if (isBatch) {
    tempList = path.join(__dirname, '.collect_batch.txt');
    fs.writeFileSync(tempList, lines.join('\n'), 'utf8');
    args.push('batch', tempList);
  } else {
    args.push('run', lines[0]);
  }
  args.push(
    '--max-videos', String(opts.maxVideos || 500),
    '--max-comments', String(opts.maxPerVideo || 500),
    '--json',
  );
  if (opts.proxy) args.push('--proxy', opts.proxy);

  const env = { ...process.env };
  // 保证 python -m 能找到项目里的 python 子包
  env.PYTHONPATH = __dirname + (env.PYTHONPATH ? ';' + env.PYTHONPATH : '');

  collectProc = spawn(PYTHON, args, { cwd: __dirname, env });

  let stdoutBuf = '';
  collectProc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const idx = stdoutBuf.lastIndexOf('\n');
    if (idx === -1) return;
    const lines = stdoutBuf.slice(0, idx).split('\n');
    stdoutBuf = stdoutBuf.slice(idx + 1);
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if (o.type === 'log') win && win.webContents.send('collector:log', `[${o.ts}] ${o.msg}`);
        else win && win.webContents.send('collector:progress', o);
      } catch {
        win && win.webContents.send('collector:log', l);
      }
    }
  });
  collectProc.stderr.on('data', (chunk) => {
    win && win.webContents.send('collector:log', '[stderr] ' + chunk.toString().trim());
  });
  collectProc.on('exit', (code) => {
    win && win.webContents.send('collector:log', `[采集进程结束，退出码 ${code}]`);
    win && win.webContents.send('collector:done', code);
    collectProc = null;
  });

  return { ok: true, msg: isBatch ? `已启动批量采集（${lines.length} 个博主）` : '采集已启动，进度看下方' };
});

ipcMain.handle('collection:kill', () => {
  if (!collectProc) return { ok: false, msg: '没有正在跑的任务' };
  try { collectProc.kill('SIGKILL'); } catch {}
  collectProc = null;
  return { ok: true, msg: '已停止采集' };
});

ipcMain.handle('collection:isRunning', () => !!collectProc);
