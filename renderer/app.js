const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';

/* 侧栏切换 */
$$('.tab').forEach(btn => btn.onclick = () => {
  $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === btn.dataset.tab));
});

function log(line) {
  const box = $('#logBox');
  box.textContent += line + '\n';
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 账号 ---------------- */
async function loadAccounts() {
  const list = await api.account.list();
  $('#accBody').innerHTML = list.map(a => `
    <tr>
      <td>${a.id}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.handle || '—')}</td>
      <td><span class="tag ${esc(a.status)}">${esc(a.status)}</span></td>
      <td>${a.tasks}</td>
      <td>${a.views || 0}</td>
      <td>
        <button class="small" data-act="check" data-id="${a.id}">检查登录</button>
        <button class="small" data-act="del" data-id="${a.id}">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="hint">还没有账号，先在上面加一个</td></tr>';

  const sel = $('#taskAcc');
  sel.innerHTML = list.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');

  $$('#accBody button').forEach(b => b.onclick = async () => {
    const id = +b.dataset.id;
    if (b.dataset.act === 'del') {
      if (!confirm('删除账号会同时清掉它的本地浏览器数据，确定？')) return;
      await api.account.remove(id); loadAccounts();
    } else {
      b.textContent = '检查中…'; b.disabled = true;
      const r = await api.account.check(id);
      b.disabled = false; b.textContent = '检查登录';
      log(r.ok ? `账号 ${id} 登录状态: ${r.logged ? '在线' : '掉线'}` : `账号 ${id} 检查失败: ${r.msg}`);
      loadAccounts();
    }
  });
}

$('#accForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api.account.add(Object.fromEntries(f));
  if (r.ok) { e.target.reset(); loadAccounts(); log('已添加账号 #' + r.id); }
  else alert(r.msg);
};

/* ---------------- 任务 ---------------- */
async function loadTasks() {
  const list = await api.task.list();
  const accs = await api.account.list();
  const nameOf = (id) => (accs.find(a => a.id === id) || {}).name || ('#' + id);

  $('#taskBody').innerHTML = list.map(t => `
    <tr>
      <td>${t.id}</td>
      <td>${esc(nameOf(t.account_id))}</td>
      <td title="${esc(t.video)}">${esc(t.video.split(/[\\/]/).pop())}</td>
      <td>${t.schedule_at ? fmtTime(t.schedule_at) : '立即'}</td>
      <td><span class="tag ${esc(t.status)}">${esc(t.status)}</span></td>
      <td>${t.tries}</td>
      <td>
        <button class="small" data-act="run" data-id="${t.id}">立即跑</button>
        <button class="small" data-act="del" data-id="${t.id}">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="hint">队列是空的</td></tr>';

  $$('#taskBody button').forEach(b => b.onclick = async () => {
    const id = +b.dataset.id;
    if (b.dataset.act === 'del') { await api.task.remove(id); loadTasks(); return; }
    b.textContent = '执行中…'; b.disabled = true;
    const r = await api.run.now(id);
    log(r.ok ? `任务 ${id} 完成 ${r.url || ''}` : `任务 ${id} 失败: ${r.msg}`);
    b.disabled = false; b.textContent = '立即跑'; loadTasks();
  });
}

$('#pickVideo').onclick = async () => {
  const files = await api.task.pickVideo();
  if (files.length) $('#videoPath').value = files[0];
};

$('#taskForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const o = Object.fromEntries(f);
  if (!o.video) return alert('先选视频');
  o.account_id = +o.account_id;
  o.schedule_at = o.schedule_at ? new Date(o.schedule_at).getTime() : null;
  const r = await api.task.add(o);
  if (r.ok) { e.target.reset(); $('#videoPath').value = ''; loadTasks(); log('任务 #' + r.id + ' 已入队'); }
  else alert(r.msg || '入队失败');
};

$('#retryFailed').onclick = async () => {
  const r = await api.run.retryFailed();
  log(`已把 ${r.count} 个失败任务重新排队`);
  loadTasks();
};

/* ---------------- 数据 ---------------- */
async function loadStats() {
  const rows = await api.stats.overview();
  $('#statsBody').innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${r.views || 0} / ${r.likes || 0}</td>
      <td>${r.followers || 0}</td>
      <td>${r.captured_at ? fmtTime(r.captured_at) : '未抓取'}</td>
      <td><button class="small" data-id="${r.id}">刷新</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">没有账号</td></tr>';

  $$('#statsBody button').forEach(b => b.onclick = async () => {
    b.textContent = '抓取中…'; b.disabled = true;
    const r = await api.stats.refresh(+b.dataset.id);
    b.disabled = false; b.textContent = '刷新';
    log(r.ok ? `数据已更新: 粉丝 ${r.followers} 赞 ${r.likes}` : `抓取失败: ${r.msg}`);
    loadStats();
  });
}

/* ---------------- 采集 ---------------- */
async function loadCollectAccounts() {
  const list = await api.account.list();
  const sel = $('#collectAcc');
  sel.innerHTML = '<option value="">匿名浏览器（可见数量可能受限）</option>' +
    list.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
}

async function loadCollections() {
  const rows = await api.collection.list();
  $('#collectBody').innerHTML = rows.map(r => {
    const statusLabel = { pending:'等待', running:'采集中', done:'完成', failed:'失败' }[r.status] || r.status;
    const errorTip = r.status === 'failed' && r.last_error ? ` title="${esc(r.last_error)}"` : '';
    return `<tr>
      <td>${r.id}</td>
      <td>${esc(r.blogger_handle)}</td>
      <td><span class="tag ${esc(r.status)}"${errorTip}>${statusLabel}</span></td>
      <td>${r.processed_videos || 0} / ${r.total_videos || 0}</td>
      <td>${r.unique_users || 0}（评论 ${r.total_comments || 0}）</td>
      <td>
        ${r.status === 'done' ? `<button class="small" data-act="view" data-id="${r.id}">查看画像</button>
                                  <button class="small" data-act="csv" data-id="${r.id}">导出CSV</button>` : ''}
        <button class="small" data-act="del" data-id="${r.id}">删</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="hint">还没启动过采集，上面填博主链接跑起来</td></tr>';

  $$('#collectBody button').forEach(b => b.onclick = async () => {
    const id = +b.dataset.id;
    if (b.dataset.act === 'del') {
      if (!confirm('删除这个采集任务（同时清除它对应的用户画像），确定？')) return;
      await api.collection.remove(id);
      hideProfiles();
      loadCollections();
    } else if (b.dataset.act === 'view') {
      await showProfiles(id);
    } else if (b.dataset.act === 'csv') {
      const r = await api.collection.exportCsv(id);
      alert(r.ok ? `已导出到:\n${r.path}\n共 ${r.count} 行` : ('导出失败: ' + r.msg));
    }
  });
}

let collectTimer = null;
function startCollectPolling() {
  if (collectTimer) return;
  loadCollections();
  collectTimer = setInterval(loadCollections, 3000);
}
function stopCollectPolling() {
  if (collectTimer) { clearInterval(collectTimer); collectTimer = null; }
}

$('#collectForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const o = Object.fromEntries(f);
  if (!o.input) return alert('填博主链接或 handle');
  const running = await api.collection.isRunning();
  if (running) return alert('已有采集在跑，先点停止');
  const r = await api.collection.run({
    input: o.input.trim(),
    accountId: o.account_id ? +o.account_id : null,
    maxPerVideo: o.maxPerVideo ? +o.maxPerVideo : 500,
    proxy: (o.proxy || '').trim() || null,
  });
  if (r.ok) {
    log(r.msg);
    $('#collectLog').textContent = '';
    $('#collectProgress').textContent = '采集已启动，正在初始化…';
    $('#collectStart').style.display = 'none';
    $('#collectStop').style.display = 'inline-block';
    startCollectPolling();
  } else alert(r.msg);
};

$('#collectStop').onclick = async () => {
  if (!confirm('确定停止当前采集？')) return;
  const r = await api.collection.kill();
  alert(r.ok ? '已停止' : ('失败: ' + r.msg));
  $('#collectStart').style.display = 'inline-block';
  $('#collectStop').style.display = 'none';
  stopCollectPolling();
  loadCollections();
};

$('#collectRefresh').onclick = loadCollections;
$('#collectClear').onclick = async () => {
  if (!confirm('⚠️ 会清空所有采集任务和用户画像，确定？')) return;
  await api.collection.clear();
  hideProfiles();
  loadCollections();
};

async function showProfiles(collectionId) {
  const rows = await api.collection.profiles(collectionId);
  $('#profilesArea').style.display = 'block';
  $('#profilesTitle').textContent = `任务 #${collectionId} 的用户画像（${rows.length} 人）`;
  $('#profilesBody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.avatar ? `<img src="${esc(r.avatar)}" class="ava">` : ''}</td>
      <td><a href="https://www.tiktok.com/${esc(r.handle)}" target="_blank">${esc(r.handle)}</a></td>
      <td>${esc(r.nickname)}</td>
      <td>${r.followers.toLocaleString()}</td>
      <td>${r.likes.toLocaleString()}</td>
      <td>${r.videos.toLocaleString()}</td>
      <td class="bio">${esc(r.bio)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="hint">这条任务没有采集到画像</td></tr>';
  $('#exportCsv').onclick = async () => {
    const r = await api.collection.exportCsv(collectionId);
    alert(r.ok ? `已导出到:\n${r.path}\n共 ${r.count} 行` : ('导出失败: ' + r.msg));
  };
}
function hideProfiles() { $('#profilesArea').style.display = 'none'; }

/* ---------------- 事件 ---------------- */
api.on('run:log', (line) => log(line));
api.on('collector:log', (line) => {
  $('#collectLog').textContent += line + '\n';
  $('#collectLog').scrollTop = $('#collectLog').scrollHeight;
});
api.on('collector:done', () => {
  $('#collectStart').style.display = 'inline-block';
  $('#collectStop').style.display = 'none';
  stopCollectPolling();
  loadCollections();
});
api.on('collector:progress', (p) => {
  let s = '';
  if (p.videos_total != null) s += `视频 ${p.videos_done || 0}/${p.videos_total}  `;
  if (p.comments_seen != null) s += `评论用户 ${p.comments_seen}  `;
  if (p.profiles_total != null) s += `画像 ${p.profiles_done || 0}/${p.profiles_total}  `;
  if (p.unique_users != null) s += `唯一用户 ${p.unique_users}`;
  $('#collectProgress').textContent = s;
});
api.on('scheduler:event', (e) => {
  if (e.type === 'start') log(`[调度] 开始执行任务 #${e.task}`);
  if (e.type === 'end') { log(`[调度] 任务 #${e.task} ${e.ok ? '成功' : '失败 ' + e.msg}`); loadTasks(); }
  if (e.type === 'log') log(e.log);
  if (e.type === 'error') log('[调度错误] ' + e.msg);
});

loadAccounts(); loadTasks(); loadStats();
loadCollections();
