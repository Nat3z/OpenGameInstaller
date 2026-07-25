import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';
import {
  emptyObserverState,
  type ObserverState,
  reduceObserverEvents,
} from './observer-state';
import { readRunEvents } from './run-events';

export type ObserverCommand =
  | { type: 'start'; suite: 'application-smoke' }
  | { type: 'stop' }
  | { type: 'rerun-failed' };

type RunAnnouncement = {
  runId: string;
  sandboxDirectory: string;
  eventLogPath: string;
};

type ObserverServerOptions = {
  distDirectory?: string;
  hostname?: string;
  openWindow?: boolean;
  runnerCommand?: string[];
  pollIntervalMilliseconds?: number;
};

type SocketData = { authenticated: true };

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const e2eDirectory = resolve(currentDirectory, '..');
const defaultDistDirectory = join(e2eDirectory, 'observer-dist');
const sessionCookieName = 'ogi-observer-session';
const failureOutcomes = new Set(['Failed', 'Flaky', 'Infrastructure Failed']);

function parseCookies(header: string | null) {
  return Object.fromEntries(
    (header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        return separator === -1
          ? [part, '']
          : [part.slice(0, separator), part.slice(separator + 1)];
      })
  );
}

function contentType(path: string) {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function safePath(root: string, requestedPath: string) {
  const candidate = resolve(root, requestedPath);
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === '' ||
    pathFromRoot.startsWith('..') ||
    resolve(root, pathFromRoot) !== candidate
  ) {
    return null;
  }
  return candidate;
}

export async function createObserverServer(
  options: ObserverServerOptions = {}
) {
  const hostname = options.hostname ?? '127.0.0.1';
  if (
    hostname !== '127.0.0.1' &&
    hostname !== '::1' &&
    hostname !== 'localhost'
  ) {
    throw new Error('Observer Window server must bind to loopback');
  }
  const distDirectory = options.distDirectory ?? defaultDistDirectory;
  const bootstrapToken = randomBytes(32).toString('base64url');
  const sessionToken = randomBytes(32).toString('base64url');
  const observerDirectory = mkdtempSync(join(tmpdir(), 'ogi-observer-'));
  const runnerCommand = options.runnerCommand ?? [
    process.execPath,
    'run',
    'src/run-application-scenario.ts',
  ];
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const outputLines: string[] = [];
  let bootstrapConsumed = false;
  let child: ChildProcess | null = null;
  let observerWindowProcess: ChildProcess | null = null;
  let announcementPath: string | null = null;
  let cancellationPath: string | null = null;
  let forceStopTimer: ReturnType<typeof setTimeout> | null = null;
  let announcement: RunAnnouncement | null = null;
  let state = emptyObserverState();
  let lastState: ObserverState | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const authenticated = (request: Request) =>
    parseCookies(request.headers.get('cookie'))[sessionCookieName] ===
    sessionToken;

  const snapshot = () => ({
    ...state,
    processActive: child !== null,
    canRerun:
      child === null &&
      state.outcome !== null &&
      failureOutcomes.has(state.outcome),
    output: outputLines.slice(-400),
  });

  const broadcast = () => {
    const message = JSON.stringify({ type: 'snapshot', state: snapshot() });
    for (const socket of sockets) socket.send(message);
  };

  const refreshState = () => {
    if (!announcement?.eventLogPath || !existsSync(announcement.eventLogPath)) {
      return;
    }
    try {
      const events = readRunEvents(announcement.eventLogPath);
      const nextState = reduceObserverEvents(events);
      if (child === null && nextState.outcome === null) {
        nextState.status = 'Aborted';
        nextState.outcome = 'Aborted';
        nextState.totals.Aborted = Math.max(1, nextState.totals.Aborted);
      }
      if (
        nextState.lastSequence !== state.lastSequence ||
        nextState.status !== state.status
      ) {
        state = nextState;
        broadcast();
      }
    } catch (cause) {
      outputLines.push(
        `Observer rejected an invalid Run Event Log update: ${(cause as Error).message}`
      );
      broadcast();
    }
  };

  const readAnnouncement = () => {
    if (announcement || !announcementPath || !existsSync(announcementPath)) {
      return;
    }
    const value = JSON.parse(readFileSync(announcementPath, 'utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as RunAnnouncement).runId !== 'string' ||
      typeof (value as RunAnnouncement).sandboxDirectory !== 'string' ||
      typeof (value as RunAnnouncement).eventLogPath !== 'string'
    ) {
      throw new Error('Runner announcement is invalid');
    }
    const candidate = value as RunAnnouncement;
    if (!safePath(candidate.sandboxDirectory, candidate.eventLogPath)) {
      throw new Error(
        'Runner announcement event log escapes its Scenario Sandbox'
      );
    }
    announcement = candidate;
    broadcast();
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(() => {
      try {
        readAnnouncement();
        refreshState();
      } catch (cause) {
        outputLines.push(`Observer update failed: ${(cause as Error).message}`);
        broadcast();
      }
    }, options.pollIntervalMilliseconds ?? 100);
  };

  const clearForceStop = () => {
    if (forceStopTimer) clearTimeout(forceStopTimer);
    forceStopTimer = null;
  };

  const requestStop = () => {
    if (!child || !cancellationPath) throw new Error('No run is active');
    writeFileSync(cancellationPath, new Date().toISOString());
    clearForceStop();
    const activeChild = child;
    forceStopTimer = setTimeout(() => {
      if (child === activeChild) activeChild.kill('SIGTERM');
    }, 30_000);
  };

  const startRun = () => {
    if (child) throw new Error('A run is already active');
    lastState = state.runId ? state : lastState;
    state = emptyObserverState();
    announcement = null;
    const controlId = randomUUID();
    announcementPath = join(observerDirectory, `${controlId}.json`);
    cancellationPath = join(observerDirectory, `${controlId}.cancel`);
    const [command, ...args] = runnerCommand;
    if (!command) throw new Error('Observer runner command is empty');
    child = spawn(command, args, {
      cwd: e2eDirectory,
      env: {
        ...process.env,
        OGI_OBSERVER_ANNOUNCEMENT: announcementPath,
        OGI_OBSERVER_CANCELLATION: cancellationPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        outputLines.push(
          ...chunk
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .filter(Boolean)
        );
        broadcast();
      });
    }
    child.once('error', (cause) => {
      outputLines.push(`Runner failed to start: ${cause.message}`);
      clearForceStop();
      child = null;
      refreshState();
      broadcast();
    });
    child.once('exit', (status, signal) => {
      outputLines.push(
        `Runner exited with status ${status} and signal ${signal}`
      );
      clearForceStop();
      child = null;
      readAnnouncement();
      refreshState();
      lastState = state;
      broadcast();
    });
    startPolling();
    broadcast();
  };

  const handleCommand = (command: ObserverCommand) => {
    switch (command.type) {
      case 'start':
        startRun();
        return;
      case 'stop':
        requestStop();
        return;
      case 'rerun-failed': {
        const prior = state.runId ? state : lastState;
        if (!prior?.outcome || !failureOutcomes.has(prior.outcome)) {
          throw new Error('The previous run did not fail');
        }
        startRun();
        return;
      }
    }
  };

  const server = Bun.serve<SocketData>({
    hostname,
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/observer' && url.searchParams.has('token')) {
        const suppliedToken = url.searchParams.get('token');
        if (bootstrapConsumed || suppliedToken !== bootstrapToken) {
          return new Response('Observer token is invalid or already used', {
            status: 401,
          });
        }
        const indexPath = join(distDirectory, 'index.html');
        if (!existsSync(indexPath)) {
          return new Response('Observer Window is not built', { status: 503 });
        }
        bootstrapConsumed = true;
        return new Response(Bun.file(indexPath), {
          headers: {
            'content-type': contentType(indexPath),
            'set-cookie': `${sessionCookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      if (!authenticated(request)) {
        return new Response('Observer authentication required', {
          status: 401,
        });
      }
      if (url.pathname === '/ws') {
        return server.upgrade(request, { data: { authenticated: true } })
          ? undefined
          : new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/api/state') {
        return Response.json(snapshot(), {
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (url.pathname === '/artifact') {
        if (!announcement)
          return new Response('No active run', { status: 404 });
        const requestedPath = url.searchParams.get('path') ?? '';
        const artifactPath = safePath(
          announcement.sandboxDirectory,
          requestedPath
        );
        if (!artifactPath || !existsSync(artifactPath)) {
          return new Response('Artifact not found', { status: 404 });
        }
        return new Response(Bun.file(artifactPath), {
          headers: { 'content-type': contentType(artifactPath) },
        });
      }
      const assetPath =
        url.pathname === '/'
          ? join(distDirectory, 'index.html')
          : safePath(distDirectory, url.pathname.slice(1));
      if (!assetPath || !existsSync(assetPath)) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(Bun.file(assetPath), {
        headers: { 'content-type': contentType(assetPath) },
      });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        refreshState();
        socket.send(JSON.stringify({ type: 'snapshot', state: snapshot() }));
      },
      message(socket, message) {
        try {
          const value = JSON.parse(String(message)) as ObserverCommand;
          if (
            !value ||
            typeof value !== 'object' ||
            !['start', 'stop', 'rerun-failed'].includes(value.type) ||
            (value.type === 'start' && value.suite !== 'application-smoke')
          ) {
            throw new Error('Observer command is invalid');
          }
          handleCommand(value);
        } catch (cause) {
          socket.send(
            JSON.stringify({
              type: 'command-error',
              message: (cause as Error).message,
            })
          );
        }
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });

  const url = `http://${hostname}:${server.port}/observer?token=${bootstrapToken}`;
  if (options.openWindow !== false) {
    try {
      const electronPath = require('electron') as string;
      observerWindowProcess = spawn(
        electronPath,
        [
          '--no-sandbox',
          join(currentDirectory, 'observer-window-main.cjs'),
          url,
        ],
        { stdio: 'ignore' }
      );
      observerWindowProcess.once('error', () => {
        observerWindowProcess = null;
        // Side-by-side presentation is best effort and never affects the run.
      });
      observerWindowProcess.once('exit', () => {
        observerWindowProcess = null;
      });
    } catch {
      // Side-by-side presentation is best effort and never affects the run.
    }
  }

  return {
    hostname,
    port: server.port,
    url,
    getState: snapshot,
    command: handleCommand,
    close: async () => {
      stopPolling();
      if (child) {
        const activeChild = child;
        await new Promise<void>((resolveClose) => {
          if (
            activeChild.exitCode !== null ||
            activeChild.signalCode !== null
          ) {
            resolveClose();
            return;
          }
          const forceTimer = setTimeout(
            () => activeChild.kill('SIGKILL'),
            15_000
          );
          activeChild.once('exit', () => {
            clearTimeout(forceTimer);
            resolveClose();
          });
          requestStop();
        });
      }
      clearForceStop();
      observerWindowProcess?.kill('SIGTERM');
      server.stop(true);
    },
  };
}
