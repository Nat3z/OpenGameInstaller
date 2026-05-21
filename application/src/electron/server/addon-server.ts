import express, { type Request } from 'express';
const port = 7654;
import http from 'http';
import { AddonServer } from '@ogi-sdk/addon-server';
import addonProcedures from '@/electron/server/api/addons.js';
import deferProcedures from '@/electron/server/api/defer.js';
import { AddonIPC } from '@/electron/server/ipc.js';
import { z } from 'zod';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
const app = express();
const server = http.createServer(app);

export const launchForwardPayloadSchema = z.object({
  gameId: z.number().int().nonnegative(),
  noLaunch: z.boolean().default(false),
  runPre: z.boolean().default(false),
  runPost: z.boolean().default(false),
  wrapperCommand: z.string().nullable().optional(),
  originalArgv: z.array(z.string()).optional(),
  launchEnv: z.record(z.string(), z.string()).optional(),
});

export type LaunchForwardPayload = z.infer<typeof launchForwardPayloadSchema>;

type FocusRequestHandler = () => boolean | Promise<boolean>;
type LaunchRequestHandler = (
  payload: LaunchForwardPayload
) =>
  | { success: boolean; error?: string }
  | Promise<{ success: boolean; error?: string }>;

let focusRequestHandler: FocusRequestHandler | null = null;
let launchRequestHandler: LaunchRequestHandler | null = null;
export function registerInstanceBridgeHandlers(handlers: {
  onFocus?: FocusRequestHandler;
  onLaunch?: LaunchRequestHandler;
}) {
  focusRequestHandler = handlers.onFocus ?? null;
  launchRequestHandler = handlers.onLaunch ?? null;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  return normalized === '127.0.0.1' || normalized === '::1';
}

function isLocalOnlyRequest(request: Request): boolean {
  return isLoopbackAddress(request.socket.remoteAddress ?? undefined);
}

app.use(express.json());

app.use('/internal', (req, res, next) => {
  if (!isLocalOnlyRequest(req)) {
    res.status(403).json({ success: false, error: 'Local access only' });
    return;
  }
  next();
});

app.get('/internal/ping', (_, res) => {
  res.json({
    ok: true,
    service: 'OpenGameInstaller',
    port,
  });
});

app.post('/internal/focus', async (_, res) => {
  if (!focusRequestHandler) {
    res
      .status(503)
      .json({ success: false, error: 'Focus handler unavailable' });
    return;
  }

  try {
    const focused = await focusRequestHandler();
    if (!focused) {
      res
        .status(409)
        .json({ success: false, error: 'No active window to focus' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/internal/launch', async (req, res) => {
  if (!launchRequestHandler) {
    res
      .status(503)
      .json({ success: false, error: 'Launch handler unavailable' });
    return;
  }

  const parsedPayload = launchForwardPayloadSchema.safeParse(req.body);
  if (!parsedPayload.success) {
    res.status(400).json({
      success: false,
      error: 'Invalid launch payload',
    });
    return;
  }

  try {
    const result = await launchRequestHandler(parsedPayload.data);
    if (!result.success) {
      res.status(409).json(result);
      return;
    }
    res.status(202).json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const addonIPC = new AddonIPC({
  ...addonProcedures,
  ...deferProcedures,
});

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

const addonServer = new AddonServer({
  port,
  securityCheck: isSecurityCheckEnabled,
});

addonServer.extend(server);

addonServer.on('disconnect', (reason) => {
  addonServer.emit('notification', {
    type: 'error',
    message: reason,
    id: 'addon-disconnect-' + Math.random().toString(36).substring(7),
  });
});

let addonServerStarting: Promise<void> | null = null;

function startAddonServer() {
  if (server.listening) {
    return Promise.resolve();
  }
  if (addonServerStarting) {
    return addonServerStarting;
  }

  addonServerStarting = new Promise<void>((resolve, reject) => {
    const onListening = () => {
      cleanup();
      addonServerStarting = null;
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      addonServerStarting = null;
      reject(error);
    };
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };

    server.once('listening', onListening);
    server.once('error', onError);

    try {
      void addonServer.start();
    } catch (error) {
      onError(error as Error);
    }
  });

  return addonServerStarting;
}

export {
  port,
  server,
  addonServer,
  addonIPC,
  isSecurityCheckEnabled,
  startAddonServer,
};
