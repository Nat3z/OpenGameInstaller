const port = 7654;
import { AddonServer } from '@ogi-sdk/addon-server';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { __dirname } from '@/electron/manager/manager.paths.js';

let isSecurityCheckEnabled = true;
if (existsSync(join(__dirname, 'config/option/developer.json'))) {
  const developerConfig = JSON.parse(
    readFileSync(join(__dirname, 'config/option/developer.json'), 'utf-8')
  );
  isSecurityCheckEnabled = developerConfig.disableSecretCheck !== true;
  if (!isSecurityCheckEnabled) {
    for (let i = 0; i < 10; i++) {
      console.warn(
        'WARNING Security check is disabled. THIS IS A MAJOR SECURITY RISK. PLEASE ENABLE DURING NORMAL USE.'
      );
    }
  }
}

function createAddonServer() {
  const server = new AddonServer({
    port,
    securityCheck: isSecurityCheckEnabled,
  });
  server.on('disconnect', (reason) => {
    server.emit('notification', {
      type: 'error',
      message: reason,
      id: 'addon-disconnect-' + Math.random().toString(36).substring(7),
    });
  });
  return server;
}

let addonServer = createAddonServer();

let addonServerStarting: Promise<void> | null = null;
let isAddonServerListening = false;

function startAddonServer() {
  if (isAddonServerListening) {
    return Promise.resolve();
  }
  if (addonServerStarting) {
    return addonServerStarting;
  }

  addonServer = createAddonServer();

  addonServerStarting = new Promise<void>((resolve, reject) => {
    const onStart = () => {
      addonServerStarting = null;
      isAddonServerListening = true;
      resolve();
    };

    addonServer.on('start', onStart);

    void addonServer.start().catch((error) => {
      addonServerStarting = null;
      reject(error);
    });
  });

  return addonServerStarting;
}

function stopAddonServer() {
  if (!isAddonServerListening) {
    return;
  }
  addonServer.stop();
  isAddonServerListening = false;
}

export {
  port,
  addonServer,
  isSecurityCheckEnabled,
  isAddonServerListening,
  startAddonServer,
  stopAddonServer,
};
