const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  account: {
    list:   ()        => ipcRenderer.invoke('account:list'),
    add:    (d)       => ipcRenderer.invoke('account:add', d),
    remove: (id)      => ipcRenderer.invoke('account:remove', id),
    check:  (id)      => ipcRenderer.invoke('account:check', id),
    dir:    (id)      => ipcRenderer.invoke('account:profileDir', id)
  },
  task: {
    list:      ()     => ipcRenderer.invoke('task:list'),
    add:       (t)    => ipcRenderer.invoke('task:add', t),
    remove:    (id)   => ipcRenderer.invoke('task:remove', id),
    pickVideo: ()     => ipcRenderer.invoke('task:pickVideo')
  },
  run: {
    now:        (id)  => ipcRenderer.invoke('run:now', id),
    retryFailed: ()   => ipcRenderer.invoke('run:retryFailed')
  },
  stats: {
    refresh:  (id)    => ipcRenderer.invoke('stats:refresh', id),
    get:      (id)    => ipcRenderer.invoke('stats:get', id),
    overview: ()      => ipcRenderer.invoke('stats:overview')
  },
  collection: {
    list:    ()       => ipcRenderer.invoke('collection:list'),
    remove:  (id)     => ipcRenderer.invoke('collection:remove', id),
    run:     (opts)   => ipcRenderer.invoke('collection:run', opts),
    kill:    ()       => ipcRenderer.invoke('collection:kill'),
    isRunning: ()     => ipcRenderer.invoke('collection:isRunning'),
    profiles: (id)    => ipcRenderer.invoke('collection:profiles', id),
    exportCsv: (id)   => ipcRenderer.invoke('collection:exportCsv', id),
    clear:    ()      => ipcRenderer.invoke('collection:clear')
  },
  on: (channel, cb) => {
    const allow = ['run:log', 'scheduler:event', 'collector:log', 'collector:progress', 'collector:done'];
    if (allow.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
