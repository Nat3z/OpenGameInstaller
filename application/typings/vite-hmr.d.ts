/**
 * Vite HMR (Hot Module Replacement) API types.
 * import.meta.hot is defined when running under Vite's dev server.
 */
interface ViteHotPayload {
  path: string;
  timestamp: number;
  updates?: { path: string; timestamp: number; type: 'js' | 'css' }[];
}

interface ImportMeta {
  hot?: {
    readonly data: Record<string, unknown>;
    accept(): void;
    accept(cb: (payload: ViteHotPayload) => void): void;
    accept(deps: string[], cb: (payload: ViteHotPayload) => void): void;
    acceptExports(
      exportNames: string[],
      cb: (payload: ViteHotPayload) => void
    ): void;
    dispose(cb: (data: Record<string, unknown>) => void): void;
    prune(cb: () => void): void;
    invalidate(message?: string): void;
    on(event: 'vite:beforeUpdate', cb: (payload: ViteHotPayload) => void): void;
    on(event: 'vite:afterUpdate', cb: (payload: ViteHotPayload) => void): void;
    on(event: 'vite:beforeFullReload', cb: () => void): void;
    on(event: 'vite:invalidate', cb: (payload: { path: string }) => void): void;
    on(event: 'vite:error', cb: (payload: { err: Error }) => void): void;
    on(event: string, cb: (payload: unknown) => void): void;
    send(event: string, payload?: unknown): void;
  };
}
