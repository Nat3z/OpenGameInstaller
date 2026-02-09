export function listenUntilDownloadReady() {
    let state = {};
    const updateState = (e) => {
        if (e instanceof CustomEvent) {
            if (e.detail) {
                state[e.detail.id] = e.detail;
            }
        }
    };
    document.addEventListener('ddl:download-progress', updateState);
    return {
        flush: () => {
            document.removeEventListener('ddl:download-progress', updateState);
            return state;
        },
    };
}
//# sourceMappingURL=events.js.map