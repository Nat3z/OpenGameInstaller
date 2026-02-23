import express, { type Request } from 'express';
import cors from 'cors';
const port = 7654;
import http from 'http';
import { WebSocketServer } from 'ws';
import addonProcedures from './api/addons.js';
import deferProcedures from './api/defer.js';
import { AddonConnection } from './AddonConnection.js';
import { AddonServer } from './serve.js';
import { z } from 'zod';
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients: Map<string, AddonConnection> = new Map();

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
) => { success: boolean; error?: string } | Promise<{ success: boolean; error?: string }>;

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

wss.on('connection', async (ws) => {
  const connection = new AddonConnection(ws);
  const connected = await connection.setupWebsocket();
  if (!connected) return;

  ws.on('close', () => {
    console.log('Client disconnected', connection.addonInfo?.id);
    if (connection.addonInfo) {
      clients.delete(connection.addonInfo.id);
    }
  });

  // Client is registered in AddonConnection.authenticate (clients.set + sendIPCMessage)
});

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});
// allow cors for localhost:8080 and file urls
app.use(
  cors({
    origin: ['http://localhost:8080', 'file://'],
  })
);

app.use(express.json());

app.get('/', (_, res) => {
  res.send('Hello World!');
});

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
    res.status(503).json({ success: false, error: 'Focus handler unavailable' });
    return;
  }

  try {
    const focused = await focusRequestHandler();
    if (!focused) {
      res.status(409).json({ success: false, error: 'No active window to focus' });
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
    res.status(503).json({ success: false, error: 'Launch handler unavailable' });
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

const addonServer = new AddonServer({
  ...addonProcedures,
  ...deferProcedures,
});

export { port, server, wss, clients, addonServer };
