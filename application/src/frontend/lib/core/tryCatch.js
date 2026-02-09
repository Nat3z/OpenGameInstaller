// from https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b
export function tryCatch(fn) {
    try {
        const result = fn();
        if (result instanceof Promise) {
            return result
                .then((data) => ({ data, error: null }))
                .catch((e) => {
                return { data: null, error: e };
            });
        }
        else {
            return { data: result, error: null };
        }
    }
    catch (e) {
        return { data: null, error: e };
    }
}
//# sourceMappingURL=tryCatch.js.map