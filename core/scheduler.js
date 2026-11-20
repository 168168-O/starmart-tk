const db = require('../db');
const uploader = require('./uploader');

/* 只做一件事：每 30 秒看一次有没有到点的任务，串行跑，绝不并发。
   串行是为了让同一台机器上的账号不要同时动作，避免被平台关联。 */
let timer = null;
let busy = false;

function start(emit) {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const due = db.tasks.due(Date.now());
      for (const t of due) {
        emit({ type: 'start', task: t.id });
        const r = await uploader.run(t, (log) => emit({ type: 'log', task: t.id, log }));
        emit({ type: 'end', task: t.id, ok: r.ok, msg: r.msg || '' });
      }
    } catch (e) {
      emit({ type: 'error', msg: String(e.message || e) });
    } finally {
      busy = false;
    }
  }, 30000);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop };
