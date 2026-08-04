import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RpcMessage, RpcServer } from '@effect/rpc';
import { Effect, Mailbox, Option } from 'effect';
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { isDev } from '@/electron/manager/manager.paths.js';
import { invokeElectronRpcHandler } from '@/electron/rpc/handlers.js';
import { forkElectronEffect, runElectronEffect } from '@/electron/runtime.js';
import {
  ELECTRON_RPC_CHANNEL,
  type ElectronRpcRequest,
  ElectronRpcs,
} from '@/lib/electron-rpc.js';

type PendingReply = {
  readonly resolve: (response: RpcMessage.FromServerEncoded) => void;
  readonly reject: (cause: unknown) => void;
};

type RpcSession = {
  readonly clientId: number;
  readonly webContentsId: number;
};

type ObservedWebContents = {
  readonly webContents: WebContents;
  readonly onNavigation: (
    event: Electron.Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ) => void;
  readonly onDestroyed: () => void;
};

let registered = false;

function isAllowedSenderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (isDev() && parsed.origin === 'http://localhost:8080') return true;
    if (parsed.protocol !== 'file:') return false;

    const senderPath = path.resolve(fileURLToPath(parsed));
    const allowedPaths = [
      path.resolve(app.getAppPath(), 'public', 'splash.html'),
      path.resolve(app.getAppPath(), 'out', 'renderer', 'index.html'),
    ];
    return allowedPaths.includes(senderPath);
  } catch {
    return false;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^(0|[1-9]\d*)$/.test(value)
  );
}

function isHeaders(value: unknown): value is ReadonlyArray<[string, string]> {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === 'string' &&
        header[0].length <= 1024 &&
        typeof header[1] === 'string' &&
        header[1].length <= 8192
    )
  );
}

function isRpcMessage(value: unknown): value is RpcMessage.FromClientEncoded {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('_tag' in value) ||
    typeof value._tag !== 'string'
  ) {
    return false;
  }

  switch (value._tag) {
    case 'Request':
      return (
        'id' in value &&
        isRequestId(value.id) &&
        'tag' in value &&
        isIdentifier(value.tag) &&
        'payload' in value &&
        'headers' in value &&
        isHeaders(value.headers)
      );
    case 'Ack':
    case 'Interrupt':
      return 'requestId' in value && isRequestId(value.requestId);
    case 'Ping':
    case 'Eof':
      return true;
    default:
      return false;
  }
}

function parseRequest(value: unknown): ElectronRpcRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid Electron RPC request');
  }

  const candidate = value as {
    readonly sessionId?: unknown;
    readonly message?: unknown;
  };
  if (
    typeof candidate.sessionId !== 'string' ||
    !UUID_PATTERN.test(candidate.sessionId) ||
    !isRpcMessage(candidate.message)
  ) {
    throw new Error('Invalid Electron RPC request');
  }

  return {
    sessionId: candidate.sessionId,
    message: candidate.message,
  };
}

const handlers = ElectronRpcs.toLayer({
  GetOperatingSystem: () => Effect.succeed(process.platform),
  InvokeElectronHandler: ({ channel, args }) =>
    invokeElectronRpcHandler(channel, args),
});

const server = Effect.scoped(
  Effect.gen(function* () {
    const disconnects = yield* Mailbox.make<number>();
    const pendingReplies = new Map<number, Map<string, PendingReply>>();
    const sessions = new Map<string, RpcSession>();
    const activeSessions = new Map<number, string>();
    const observedWebContents = new Map<number, ObservedWebContents>();
    let nextClientId = 1;

    const rejectPendingReplies = (clientId: number, cause: unknown): void => {
      const replies = pendingReplies.get(clientId);
      if (!replies) return;
      for (const reply of replies.values()) reply.reject(cause);
      pendingReplies.delete(clientId);
    };

    const closeSession = (
      key: string,
      cause: unknown,
      notifyDisconnect = true
    ): void => {
      const session = sessions.get(key);
      if (!session) return;

      sessions.delete(key);
      if (activeSessions.get(session.webContentsId) === key) {
        activeSessions.delete(session.webContentsId);
      }
      rejectPendingReplies(session.clientId, cause);
      if (notifyDisconnect) disconnects.unsafeOffer(session.clientId);
    };

    const closeWebContentsSessions = (
      webContentsId: number,
      cause: unknown
    ): void => {
      for (const [key, session] of sessions) {
        if (session.webContentsId === webContentsId) closeSession(key, cause);
      }
    };

    const observeWebContents = (webContents: WebContents): void => {
      if (observedWebContents.has(webContents.id)) return;

      const onNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ) => {
        if (isMainFrame && !isInPlace) {
          closeWebContentsSessions(
            webContents.id,
            new Error('Electron renderer navigated')
          );
        }
      };
      const onDestroyed = () => {
        observedWebContents.delete(webContents.id);
        closeWebContentsSessions(
          webContents.id,
          new Error('Electron renderer disconnected')
        );
      };

      webContents.on('did-start-navigation', onNavigation);
      webContents.once('destroyed', onDestroyed);
      observedWebContents.set(webContents.id, {
        webContents,
        onNavigation,
        onDestroyed,
      });
    };

    const getSession = (
      webContents: WebContents,
      sessionId: string
    ): RpcSession => {
      observeWebContents(webContents);

      const key = `${webContents.id}:${sessionId}`;
      const existing = sessions.get(key);
      if (existing) return existing;

      const previousKey = activeSessions.get(webContents.id);
      if (previousKey) {
        closeSession(previousKey, new Error('Electron renderer reloaded'));
      }

      const session = {
        clientId: nextClientId++,
        webContentsId: webContents.id,
      };
      sessions.set(key, session);
      activeSessions.set(webContents.id, key);
      return session;
    };

    const resolvePendingReply = (
      clientId: number,
      response: RpcMessage.FromServerEncoded
    ): void => {
      const replies = pendingReplies.get(clientId);
      if (!replies) return;

      if (response._tag === 'Exit') {
        const reply = replies.get(response.requestId);
        if (!reply) return;
        replies.delete(response.requestId);
        reply.resolve(response);
      } else if (
        response._tag === 'Defect' ||
        response._tag === 'ClientProtocolError'
      ) {
        for (const reply of replies.values()) reply.resolve(response);
        replies.clear();
      } else {
        const cause = new Error(
          `Unsupported Electron RPC response: ${response._tag}`
        );
        for (const reply of replies.values()) reply.reject(cause);
        replies.clear();
      }

      if (replies.size === 0) pendingReplies.delete(clientId);
    };

    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            ipcMain.handle(ELECTRON_RPC_CHANNEL, (event, value: unknown) => {
              if (
                BrowserWindow.fromWebContents(event.sender) === null ||
                event.senderFrame !== event.sender.mainFrame ||
                !isAllowedSenderUrl(event.senderFrame.url)
              ) {
                throw new Error('Unauthorized Electron RPC sender');
              }

              const { message, sessionId } = parseRequest(value);
              const session = getSession(event.sender, sessionId);

              if (message._tag !== 'Request') {
                return runElectronEffect(
                  writeRequest(session.clientId, message)
                ).then(() => undefined);
              }

              return new Promise<RpcMessage.FromServerEncoded>(
                (resolve, reject) => {
                  const replies =
                    pendingReplies.get(session.clientId) ?? new Map();
                  if (replies.has(message.id)) {
                    reject(new Error('Duplicate Electron RPC request ID'));
                    return;
                  }
                  replies.set(message.id, { resolve, reject });
                  pendingReplies.set(session.clientId, replies);

                  void runElectronEffect(
                    writeRequest(session.clientId, message)
                  ).catch((cause) => {
                    replies.delete(message.id);
                    if (replies.size === 0) {
                      pendingReplies.delete(session.clientId);
                    }
                    reject(cause);
                  });
                }
              );
            });
          }),
          () =>
            Effect.sync(() => {
              ipcMain.removeHandler(ELECTRON_RPC_CHANNEL);
              for (const observed of observedWebContents.values()) {
                observed.webContents.removeListener(
                  'did-start-navigation',
                  observed.onNavigation
                );
                observed.webContents.removeListener(
                  'destroyed',
                  observed.onDestroyed
                );
                closeWebContentsSessions(
                  observed.webContents.id,
                  new Error('Effect RPC server stopped')
                );
              }
              observedWebContents.clear();
            })
        );

        return {
          disconnects,
          send: (clientId: number, response: RpcMessage.FromServerEncoded) =>
            Effect.sync(() => resolvePendingReply(clientId, response)),
          end: (clientId: number) =>
            Effect.sync(() => {
              for (const [key, session] of sessions) {
                if (session.clientId === clientId) {
                  closeSession(
                    key,
                    new Error('Effect RPC client ended'),
                    false
                  );
                  break;
                }
              }
            }),
          clientIds: Effect.sync(
            () => new Set(Array.from(sessions.values(), (s) => s.clientId))
          ),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        };
      })
    );

    return yield* RpcServer.make(ElectronRpcs).pipe(
      Effect.provide(handlers),
      Effect.provideService(RpcServer.Protocol, protocol)
    );
  })
).pipe(
  Effect.tapErrorCause((cause) =>
    Effect.logError('Electron RPC server stopped with a failure', cause)
  ),
  Effect.ensuring(
    Effect.sync(() => {
      registered = false;
    })
  )
);

export function registerElectronRpcHandlers(): void {
  if (registered) return;
  registered = true;
  forkElectronEffect(server);
}
