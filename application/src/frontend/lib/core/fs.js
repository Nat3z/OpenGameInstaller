import { createNotification } from '../../store';
export function getDownloadPath() {
    if (!window.electronAPI.fs.exists('./config/option/general.json')) {
        if (!window.electronAPI.fs.exists('./downloads'))
            window.electronAPI.fs.mkdir('./downloads');
        createNotification({
            message: 'Download path not set, using default path (./downloads)',
            id: 'download-path',
            type: 'info',
        });
        return './downloads';
    }
    if (!window.electronAPI.fs.exists('./downloads'))
        window.electronAPI.fs.mkdir('./downloads');
    const file = window.electronAPI.fs.read('./config/option/general.json');
    const data = JSON.parse(file);
    return data.fileDownloadLocation;
}
export async function fsCheck(path) {
    try {
        return window.electronAPI.fs.exists(path);
    }
    catch (e) {
        return false;
    }
}
export function dirname(path) {
    if (!path)
        return '.';
    // Windows UNC root case
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(path))
        return path.replace(/(\\)+$/, '');
    // Check if the path had trailing slashes (indicating it's a directory)
    const hadTrailingSlash = /[\/\\]+$/.test(path);
    // Remove trailing slashes/backslashes (except at root)
    let cleaned = path.replace(/[\/\\]+$/, '');
    if (cleaned === '')
        return /^([A-Za-z]:)?[\/\\]$/.test(path) ? path : '/';
    // If the original path had trailing slashes, the cleaned path IS the directory
    if (hadTrailingSlash) {
        // Special case: Windows root (e.g., "C:\" -> "C:\")
        if (/^[A-Za-z]:$/.test(cleaned))
            return cleaned + '\\';
        return cleaned;
    }
    // Handle drive letters (Windows)
    const match = cleaned.match(/^([A-Za-z]:)([\/\\]|$)/);
    let drive = '';
    if (match) {
        drive = match[1];
        cleaned = cleaned.slice(drive.length);
    }
    // Use last slash or backslash as separator (prefer last encountered)
    const idxFwd = cleaned.lastIndexOf('/');
    const idxBack = cleaned.lastIndexOf('\\');
    const idx = Math.max(idxFwd, idxBack);
    if (idx === -1)
        return drive || '.';
    // If result is empty after cut, return just drive letter + separator or root
    let dir = cleaned.slice(0, idx);
    // Ensure we return "/" or "C:\" instead of empty string
    if (dir === '')
        return drive ? drive + '\\' : drive || '/';
    return drive + dir;
}
export function basename(path) {
    if (!path)
        return '';
    // Remove trailing slashes/backslashes except for root
    let cleaned = path.replace(/[\/\\]+$/, '');
    // Windows UNC special case (leave as-is)
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(cleaned))
        return '';
    // Remove windows drive prefix for basename search but preserve for root-only case
    // Example: "C:\foo\bar.txt"
    const match = cleaned.match(/^([A-Za-z]:)([\/\\]|$)/);
    let base = cleaned;
    if (match) {
        base = cleaned.slice(match[1].length);
        if (base === '' || base === '\\' || base === '/')
            return match[1] + (base || '');
    }
    // Find last slash or backslash
    const idxFwd = base.lastIndexOf('/');
    const idxBack = base.lastIndexOf('\\');
    const idx = Math.max(idxFwd, idxBack);
    return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}
//# sourceMappingURL=fs.js.map