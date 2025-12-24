// from https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b

export function tryCatch<T, E = Error>(fn: () => T) {
  type Result<TResult, EResult> =
    | { data: TResult; error: null }
    | { data: null; error: EResult };
  type ReturnType =
    T extends Promise<infer P> ? Promise<Result<P, E>> : Result<T, E>;

  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then((data: Promise<unknown>) => ({ data, error: null }))
        .catch((e: unknown) => {
          return { data: null, error: e as E };
        }) as ReturnType;
    } else {
      return { data: result, error: null } as ReturnType;
    }
  } catch (e: unknown) {
    return { data: null, error: e as E } as ReturnType;
  }
}
