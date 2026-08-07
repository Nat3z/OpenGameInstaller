import { randomUUID } from 'node:crypto';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { contextBridge, ipcRenderer } from 'electron';
import {
  ELECTRON_RPC_CHANNEL,
  type ElectronRpcTransport,
} from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

// === Debug: Events Processed/sec Counter ===
let dbg_eventsProcessed = 0;
let dbg_lastReportTime = Date.now();

function dbg_countEvent() {
  dbg_eventsProcessed++;
}

const wrap = (fn: (...args: any[]) => any) => {
  return (...args: any[]) => {
    dbg_countEvent();
    try {
      return fn(...args);
    } catch (e) {
      document.dispatchEvent(new CustomEvent('dbg:error', { detail: e }));
      return undefined;
    }
  };
};
const rpcSessionId = randomUUID();
const electronRpcTransport: ElectronRpcTransport = {
  invoke: (message) =>
    ipcRenderer.invoke(ELECTRON_RPC_CHANNEL, {
      sessionId: rpcSessionId,
      message,
    }),
};

setInterval(() => {
  const now = Date.now();
  const elapsed = (now - dbg_lastReportTime) / 1000;
  const eventsPerSec = dbg_eventsProcessed / elapsed;
  document.dispatchEvent(
    new CustomEvent('dbg:events-proc', { detail: { eventsPerSec } })
  );
  dbg_eventsProcessed = 0;
  dbg_lastReportTime = now;
}, 3000);

const electronApi = {
  fs: {
    read: wrap((path: string) => ipcRenderer.sendSync('fs:read', path)),
    write: wrap((path: string, data: string) =>
      ipcRenderer.sendSync('fs:write', { path, data })
    ),
    mkdir: wrap((path: string) => ipcRenderer.sendSync('fs:mkdir', path)),
    exists: wrap((path: string) => ipcRenderer.sendSync('fs:exists', path)),
    delete: wrap((path: string) =>
      ipcRenderer.sendSync('fs:delete:sync', path)
    ),
    showFileLoc: wrap((path: string) =>
      ipcRenderer.sendSync('fs:show-file-loc', path)
    ),
    stat: wrap((path: string) => ipcRenderer.sendSync('fs:stat', { path })),
  },
  app: {
    clientReadyForEvents: wrap(() =>
      ipcRenderer.send('client-ready-for-events')
    ),
  },
  getVersion: wrap(() => ipcRenderer.sendSync('get-version')),
  getTheme: wrap(() => ipcRenderer.sendSync('get-initial-theme')),
  isDev: wrap(() => ipcRenderer.sendSync('is-dev')),
};

export type ElectronApi = typeof electronApi;

contextBridge.exposeInMainWorld('electronAPI', electronApi);
contextBridge.exposeInMainWorld('electronRpcTransport', electronRpcTransport);

ipcRenderer.on(
  'ddl:download-progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-progress', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'processing:progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('processing:progress', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-error',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-error', { detail: arg })
    );
  })
);
ipcRenderer.on(
  'ddl:download-complete',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-complete', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-cancelled',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-cancelled', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-paused',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-paused', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'ddl:download-resumed',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('ddl:download-resumed', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'notification',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('new-notification', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'app:redistributable-progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:redistributable-progress', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'oobe:log',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('oobe:log', { detail: arg }));
  })
);

ipcRenderer.on(
  'torrent:download-progress',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-progress', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-error',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-error', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-complete',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-complete', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-cancelled',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-cancelled', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-paused',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-paused', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'torrent:download-resumed',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('torrent:download-resumed', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'input-asked',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('input-asked', { detail: arg }));
  })
);

ipcRenderer.on(
  'game:launch-requested',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('game:launch-requested', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'game:launch',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('game:launch', { detail: arg }));
  })
);

ipcRenderer.on(
  'game:launch-error',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('game:launch-error', { detail: arg })
    );
  })
);
ipcRenderer.on(
  'game:exit',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('game:exit', { detail: arg }));
  })
);
ipcRenderer.on(
  'addon:update-available',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('addon:update-available', { detail: arg })
    );
  })
);
ipcRenderer.on(
  'addon:updated',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('addon:updated', { detail: arg }));
  })
);

ipcRenderer.on(
  'addon-connected',
  wrap((_, arg) => {
    document.dispatchEvent(new CustomEvent('addon-connected', { detail: arg }));
  })
);

ipcRenderer.on(
  'migration:event',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent(`migration:event:${arg}`, { detail: arg })
    );
  })
);

ipcRenderer.on(
  'app:open-steam-compatdata',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:open-steam-compatdata', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'app:ask-root-password',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:ask-root-password', { detail: arg })
    );
  })
);

ipcRenderer.on(
  'all-addons-started',
  wrap(() => {
    logger.sync.info('ALL ADDONS STARTED');
    document.dispatchEvent(new CustomEvent('all-addons-started'));
  })
);

ipcRenderer.on(
  'addon-runtime-ready',
  wrap(() => {
    logger.sync.info('ADDON RUNTIME READY');
    document.dispatchEvent(new CustomEvent('addon-runtime-ready'));
  })
);

ipcRenderer.on(
  'app:show-changelog',
  wrap((_, arg) => {
    document.dispatchEvent(
      new CustomEvent('app:show-changelog', { detail: { version: arg } })
    );
  })
);

// Single-window / Steam Deck: main window shows splash.html first; forward splash IPC so it can update
ipcRenderer.on(
  'splash-status',
  wrap((_, text: string, subtext?: string) => {
    document.dispatchEvent(
      new CustomEvent('splash-status', { detail: { text, subtext } })
    );
  })
);
ipcRenderer.on(
  'splash-progress',
  wrap((_, current: number, total: number, speed?: string) => {
    document.dispatchEvent(
      new CustomEvent('splash-progress', {
        detail: { current, total, speed },
      })
    );
  })
);
