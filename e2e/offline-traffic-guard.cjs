const fs = require('node:fs');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const guardStateKey = Symbol.for('ogi.offlineTrafficGuard');

function normalizeHost(host) {
  return String(host ?? '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

function isLocalBindAddress(host) {
  const normalized = normalizeHost(host);
  return normalized === '0.0.0.0' || normalized === '::';
}

function normalizePort(port, protocol) {
  if (port !== undefined && port !== null && String(port) !== '') {
    return Number(port);
  }
  if (protocol === 'https:' || protocol === 'wss:') return 443;
  if (protocol === 'http:' || protocol === 'ws:') return 80;
  return 0;
}

function endpointExpected(expectedEndpoints, host, port) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = Number(port);
  return expectedEndpoints.some(
    (endpoint) =>
      normalizeHost(endpoint.host) === normalizedHost &&
      Number(endpoint.port) === normalizedPort
  );
}

function classifyUrl(url, expectedEndpoints = []) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'unexpected';
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return 'ignored';
  }
  return endpointExpected(
    expectedEndpoints,
    parsed.hostname,
    normalizePort(parsed.port, parsed.protocol)
  )
    ? 'expected'
    : 'unexpected';
}

function requestUrl(protocol, input, options) {
  if (options?.socketPath) return null;
  if (input?.socketPath) return null;
  if (typeof input === 'string' || input instanceof URL) return String(input);
  const requestOptions = input ?? options ?? {};
  const host = requestOptions.hostname ?? requestOptions.host ?? 'localhost';
  const port = normalizePort(requestOptions.port, protocol);
  const requestPath = requestOptions.path ?? '/';
  return `${protocol}//${host}:${port}${requestPath}`;
}

function defaultDgramAddress(socket) {
  return socket.type === 'udp6' ? '::1' : '127.0.0.1';
}

function dgramConnectEndpoint(socket, args) {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    return {
      host: first.address ?? first.host ?? defaultDgramAddress(socket),
      port: Number(first.port),
    };
  }
  return {
    host: typeof second === 'string' ? second : defaultDgramAddress(socket),
    port: Number(first),
  };
}

function dgramSendEndpoint(socket, args, connectedEndpoint) {
  const rest = args.slice(1);
  if (typeof rest.at(-1) === 'function') rest.pop();
  const first = rest[0];
  if (
    typeof first === 'object' &&
    first !== null &&
    !Buffer.isBuffer(first) &&
    !ArrayBuffer.isView(first)
  ) {
    return {
      host: first.address ?? first.host ?? defaultDgramAddress(socket),
      port: Number(first.port),
    };
  }
  if (rest.length >= 3 && rest.slice(0, 3).every(Number.isFinite)) {
    return {
      host: typeof rest[3] === 'string' ? rest[3] : defaultDgramAddress(socket),
      port: Number(rest[2]),
    };
  }
  if (connectedEndpoint) return connectedEndpoint;
  if (Number.isFinite(first)) {
    return {
      host: typeof rest[1] === 'string' ? rest[1] : defaultDgramAddress(socket),
      port: Number(first),
    };
  }
  return null;
}

function parseDnsServer(server) {
  const value = String(server).trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { host: bracketed[1], port: Number(bracketed[2] ?? 53) };
  }
  if (net.isIP(value)) return { host: value, port: 53 };
  const ipv4WithPort = value.match(/^([^:]+):(\d+)$/);
  if (ipv4WithPort) {
    return { host: ipv4WithPort[1], port: Number(ipv4WithPort[2]) };
  }
  return { host: value, port: 53 };
}

function dnsResolutionTarget(name, args) {
  if (name === 'lookupService') {
    return `${normalizeHost(args[0])}:${Number(args[1])}`;
  }
  return String(args[0] ?? 'unknown-dns-target');
}

function socketEndpoint(args) {
  const first = args[0];
  if (Array.isArray(first)) return socketEndpoint(first);
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  if (typeof first === 'object' && first !== null) {
    if (first.path || (first.socket && first.port === undefined)) return null;
    return {
      host: first.host ?? first.hostname ?? 'localhost',
      port: Number(first.port),
    };
  }
  return {
    port: Number(first),
    host: typeof args[1] === 'string' ? args[1] : 'localhost',
  };
}

function installNodeTrafficGuard({
  logPath,
  product,
  expectedEndpoints,
  truncate,
  recordListeners = false,
}) {
  const existing = globalThis[guardStateKey];
  if (existing) return existing;
  fs.mkdirSync(require('node:path').dirname(logPath), { recursive: true });
  if (truncate) fs.writeFileSync(logPath, '');
  else if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');

  const record = (transport, target, decision, method) => {
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        product,
        pid: process.pid,
        transport,
        method,
        target,
        decision,
        expected: decision === 'expected',
      })}\n`
    );
  };
  record('guard-install', product, 'expected', 'INSTALL');
  const deny = (transport, target, method) => {
    record(transport, target, 'unexpected', method);
    const error = new Error(`Offline traffic guard denied ${target}`);
    error.code = 'OGI_OFFLINE_TRAFFIC_DENIED';
    throw error;
  };
  const classifyEndpoint = (host, port) =>
    endpointExpected(expectedEndpoints, host, port) ? 'expected' : 'unexpected';

  if (recordListeners) {
    const originalListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function guardedListen(...args) {
      this.once('listening', () => {
        const address = this.address();
        if (!address || typeof address === 'string') return;
        record(
          'node-net-listen',
          `${normalizeHost(address.address)}:${address.port}`,
          'expected',
          'LISTEN'
        );
      });
      return originalListen.apply(this, args);
    };
  }

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input.url;
      const decision = classifyUrl(url, expectedEndpoints);
      if (decision === 'unexpected') deny('fetch', url, init?.method ?? 'GET');
      if (decision === 'expected') {
        record('fetch', url, decision, init?.method ?? 'GET');
      }
      return originalFetch(input, init);
    };
  }

  for (const [module, protocol, transport] of [
    [http, 'http:', 'node-http'],
    [https, 'https:', 'node-https'],
  ]) {
    const originalRequest = module.request;
    module.request = function guardedRequest(...args) {
      const [input, options] = args;
      const url = requestUrl(protocol, input, options);
      if (url === null) return originalRequest.apply(this, args);
      const decision = classifyUrl(url, expectedEndpoints);
      const method =
        (typeof input === 'object' && !(input instanceof URL)
          ? input?.method
          : options?.method) ?? 'GET';
      if (decision === 'unexpected') deny(transport, url, method);
      record(transport, url, decision, method);
      return originalRequest.apply(this, args);
    };
    module.get = function guardedGet(...args) {
      const request = module.request.apply(this, args);
      request.end();
      return request;
    };
  }

  let prototypeSuppressionDepth = 0;
  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    if (prototypeSuppressionDepth > 0) {
      return originalSocketConnect.apply(this, args);
    }
    const endpoint = socketEndpoint(args);
    if (!endpoint) return originalSocketConnect.apply(this, args);
    const target = `${normalizeHost(endpoint.host)}:${endpoint.port}`;
    const decision = classifyEndpoint(endpoint.host, endpoint.port);
    const transport =
      this instanceof tls.TLSSocket
        ? 'node-tls-socket-prototype'
        : 'node-net-socket-prototype';
    if (decision === 'unexpected') deny(transport, target, 'CONNECT');
    record(transport, target, decision, 'CONNECT');
    return originalSocketConnect.apply(this, args);
  };

  const tlsSocketHasOwnConnect = Object.hasOwn(
    tls.TLSSocket.prototype,
    'connect'
  );
  if (tlsSocketHasOwnConnect) {
    const originalTlsSocketConnect = tls.TLSSocket.prototype.connect;
    tls.TLSSocket.prototype.connect = function guardedTlsSocketConnect(
      ...args
    ) {
      if (prototypeSuppressionDepth > 0) {
        return originalTlsSocketConnect.apply(this, args);
      }
      const endpoint = socketEndpoint(args);
      if (!endpoint) return originalTlsSocketConnect.apply(this, args);
      const target = `${normalizeHost(endpoint.host)}:${endpoint.port}`;
      const decision = classifyEndpoint(endpoint.host, endpoint.port);
      if (decision === 'unexpected') {
        deny('node-tls-socket-prototype', target, 'CONNECT');
      }
      record('node-tls-socket-prototype', target, decision, 'CONNECT');
      prototypeSuppressionDepth += 1;
      try {
        return originalTlsSocketConnect.apply(this, args);
      } finally {
        prototypeSuppressionDepth -= 1;
      }
    };
  }

  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const endpoint = socketEndpoint(args);
    if (!endpoint) return originalTlsConnect.apply(this, args);
    const target = `${normalizeHost(endpoint.host)}:${endpoint.port}`;
    const decision = classifyEndpoint(endpoint.host, endpoint.port);
    if (decision === 'unexpected') deny('node-tls', target, 'CONNECT');
    record('node-tls', target, decision, 'CONNECT');
    prototypeSuppressionDepth += 1;
    try {
      return originalTlsConnect.apply(this, args);
    } finally {
      prototypeSuppressionDepth -= 1;
    }
  };

  const connectedDgramEndpoints = new WeakMap();
  const classifyDgramEndpoint = (host, port) => {
    const normalizedHost = normalizeHost(host);
    if (net.isIP(normalizedHost) === 0) return 'unexpected';
    return classifyEndpoint(normalizedHost, port);
  };
  const originalDgramConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedDgramConnect(...args) {
    const endpoint = dgramConnectEndpoint(this, args);
    const target = `${normalizeHost(endpoint.host)}:${endpoint.port}`;
    const decision = classifyDgramEndpoint(endpoint.host, endpoint.port);
    if (decision === 'unexpected') {
      deny('node-dgram-connect', target, 'CONNECT');
    }
    record('node-dgram-connect', target, decision, 'CONNECT');
    connectedDgramEndpoints.set(this, endpoint);
    return originalDgramConnect.apply(this, args);
  };

  const originalDgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedDgramSend(...args) {
    const endpoint = dgramSendEndpoint(
      this,
      args,
      connectedDgramEndpoints.get(this)
    );
    if (!endpoint) {
      deny('node-dgram-send', 'unknown-udp-endpoint', 'SEND');
    }
    const target = `${normalizeHost(endpoint.host)}:${endpoint.port}`;
    const decision = classifyDgramEndpoint(endpoint.host, endpoint.port);
    if (decision === 'unexpected') deny('node-dgram-send', target, 'SEND');
    record('node-dgram-send', target, decision, 'SEND');
    return originalDgramSend.apply(this, args);
  };

  const isDnsResolutionMethod = (name) =>
    name === 'lookupService' ||
    name === 'reverse' ||
    name.startsWith('resolve');
  const guardDnsLookup = (original, transport, promiseBased) => {
    const guarded = function guardedLookup(hostname, ...args) {
      const normalizedHostname = normalizeHost(hostname);
      if (
        isLocalBindAddress(hostname) ||
        net.isIP(normalizedHostname) ||
        expectedEndpoints.some(
          (endpoint) => normalizeHost(endpoint.host) === normalizedHostname
        )
      ) {
        return original.call(this, hostname, ...args);
      }
      deny(transport, String(hostname), 'LOOKUP');
    };
    return promiseBased
      ? async function guardedPromiseLookup(...args) {
          return guarded.apply(this, args);
        }
      : guarded;
  };
  const guardDnsResolution = (_original, name, transport, promiseBased) => {
    const guarded = function guardedResolution(...args) {
      deny(transport, dnsResolutionTarget(name, args), 'RESOLVE');
    };
    return promiseBased
      ? async function guardedPromiseResolution(...args) {
          return guarded.apply(this, args);
        }
      : guarded;
  };
  const guardDnsSetServers = (original, transport) =>
    function guardedSetServers(servers) {
      const parsedServers = Array.isArray(servers)
        ? servers.map(parseDnsServer)
        : [];
      const decision =
        parsedServers.length > 0 &&
        parsedServers.every(
          (server) =>
            net.isIP(normalizeHost(server.host)) > 0 &&
            endpointExpected(expectedEndpoints, server.host, server.port)
        )
          ? 'expected'
          : 'unexpected';
      const target = parsedServers
        .map((server) => `${normalizeHost(server.host)}:${server.port}`)
        .join(',');
      if (decision === 'unexpected') {
        deny(transport, target || 'default-dns-servers', 'SET_SERVERS');
      }
      record(transport, target, decision, 'SET_SERVERS');
      return original.call(this, servers);
    };

  const wrapDnsNamespace = (namespace, label, promiseBased) => {
    for (const name of Object.keys(namespace)) {
      const original = namespace[name];
      if (typeof original !== 'function' || name === 'Resolver') continue;
      if (name === 'lookup') {
        namespace[name] = guardDnsLookup(
          original,
          `${label}:lookup`,
          promiseBased
        );
      } else if (name === 'setServers') {
        namespace[name] = guardDnsSetServers(original, `${label}:setServers`);
      } else if (isDnsResolutionMethod(name)) {
        namespace[name] = guardDnsResolution(
          original,
          name,
          `${label}:${name}`,
          promiseBased
        );
      }
    }
  };
  wrapDnsNamespace(dns, 'node-dns', false);
  if (dns.promises) {
    wrapDnsNamespace(dns.promises, 'node-dns-promises', true);
  }

  const wrappedResolverPrototypes = new WeakSet();
  const wrapResolverClass = (ResolverClass, label, promiseBased) => {
    let prototype = ResolverClass?.prototype;
    while (prototype && prototype !== Object.prototype) {
      if (!wrappedResolverPrototypes.has(prototype)) {
        wrappedResolverPrototypes.add(prototype);
        for (const name of Object.getOwnPropertyNames(prototype)) {
          if (name === 'constructor') continue;
          const original = prototype[name];
          if (typeof original !== 'function') continue;
          if (name === 'setServers') {
            prototype[name] = guardDnsSetServers(
              original,
              `${label}:setServers`
            );
          } else if (isDnsResolutionMethod(name)) {
            prototype[name] = guardDnsResolution(
              original,
              name,
              `${label}:${name}`,
              promiseBased
            );
          }
        }
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  };
  wrapResolverClass(dns.Resolver, 'node-dns-resolver', false);
  wrapResolverClass(dns.promises?.Resolver, 'node-dns-promises-resolver', true);

  const state = { record, expectedEndpoints, sessions: new WeakSet() };
  globalThis[guardStateKey] = state;
  return state;
}

function attachElectronSessionGuard(state, session) {
  if (!session || state.sessions.has(session)) return;
  state.sessions.add(session);
  session.webRequest.onBeforeRequest((details, callback) => {
    const decision = classifyUrl(details.url, state.expectedEndpoints);
    if (decision === 'ignored') {
      callback({ cancel: false });
      return;
    }
    state.record('electron-session', details.url, decision, details.method);
    callback({ cancel: decision === 'unexpected' });
  });
}

function installOfflineTrafficGuard({
  session,
  logPath,
  product,
  expectedEndpoints = [],
  truncate = true,
  recordListeners = false,
}) {
  const state = installNodeTrafficGuard({
    logPath,
    product,
    expectedEndpoints,
    truncate,
    recordListeners,
  });
  attachElectronSessionGuard(state, session);
  return state;
}

function normalizeNodeRequirePath(modulePath) {
  return String(modulePath).replaceAll('\\', '/');
}

function descendantGuardEnvironment({
  logPath,
  product,
  expectedEndpoints = [],
  recordListeners = false,
}) {
  // NODE_OPTIONS parsing treats backslashes as escapes on Windows. Forward
  // slashes remain valid absolute Windows paths and preserve the module name.
  const guardPath = normalizeNodeRequirePath(__filename);
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  return {
    OGI_OFFLINE_TRAFFIC_GUARD_CONFIG: JSON.stringify({
      logPath,
      product,
      expectedEndpoints,
      recordListeners,
    }),
    NODE_OPTIONS: [
      existingNodeOptions,
      `--require="${guardPath.replaceAll('"', '\\"')}"`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

if (
  process.env.OGI_OFFLINE_TRAFFIC_GUARD_CONFIG &&
  !globalThis[guardStateKey]
) {
  const config = JSON.parse(process.env.OGI_OFFLINE_TRAFFIC_GUARD_CONFIG);
  const state = installNodeTrafficGuard({ ...config, truncate: false });
  try {
    const electron = require('electron');
    if (electron?.app?.whenReady && electron?.session) {
      electron.app
        .whenReady()
        .then(() => {
          attachElectronSessionGuard(state, electron.session.defaultSession);
          state.record(
            'electron-session-guard-install',
            'defaultSession',
            'expected',
            'INSTALL'
          );
        })
        .catch((error) => {
          state.record(
            'electron-session-guard-install',
            error?.message ?? 'unknown error',
            'unexpected',
            'INSTALL'
          );
        });
    }
  } catch {
    // Descendant Node helpers still retain the Node-level traffic guard.
  }
}

module.exports = {
  classifyUrl,
  descendantGuardEnvironment,
  requestUrl,
  installOfflineTrafficGuard,
  normalizeNodeRequirePath,
};
