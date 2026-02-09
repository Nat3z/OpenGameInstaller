/**
 * Sanitizes a path segment (e.g. result.name or result.filename) to prevent path traversal
 * and invalid characters. Returns a safe basename-like segment.
 */
export function sanitizePathSegment(segment) {
    if (segment == null || segment === '')
        return 'download';
    const normalized = segment.replace(/[/\\]+/g, '/').replace(/\.\./g, '');
    const parts = normalized.split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? 'download';
    const cleaned = last
        .replace(/[\0<>:"|?*]/g, '_')
        .replace(/^\.+$/, '')
        .substring(0, 255);
    return cleaned || 'download';
}
//# sourceMappingURL=pathUtils.js.map