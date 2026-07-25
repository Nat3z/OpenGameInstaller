import { AddonServer } from '@ogi-sdk/addon-server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { __dirname } from '@/electron/manager/manager.paths.js';

let isSecurityCheckEnabled = true;
let port = 7654;
if (existsSync(join(__dirname, 'config/option/developer.json'))) {
  const developerConfig = JSON.parse(
    readFileSync(join(__dirname, 'config/option/developer.json'), 'utf-8')
  );
  if (typeof developerConfig.clientSdkUrl === 'string') {
    try {
      const configuredPort = Number(new URL(developerConfig.clientSdkUrl).port);
      if (Number.isInteger(configuredPort) && configuredPort > 0) {
        port = configuredPort;
      }
    } catch {
      console.warn('Ignoring invalid developer clientSdkUrl');
    }
  }
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

async function stopAddonServer(): Promise<void> {
  if (addonServerStarting) {
    await addonServerStarting;
  }
  if (!isAddonServerListening) {
    return;
  }
  await addonServer.stop();
  isAddonServerListening = false;
}

export {
  addonServer,
  isAddonServerListening,
  isSecurityCheckEnabled,
  port,
  startAddonServer,
  stopAddonServer,
};
