/**
 * Library file operations
 */
import { join } from 'path';
import * as fs from 'fs';
import { __dirname } from '../../manager/manager.paths.js';
export function getLibraryPath(appID) {
    return join(__dirname, `library/${appID}.json`);
}
export function loadLibraryInfo(appID) {
    const appPath = getLibraryPath(appID);
    if (!fs.existsSync(appPath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(appPath, 'utf-8'));
}
export function loadLibraryInfoOrThrow(appID) {
    const appInfo = loadLibraryInfo(appID);
    if (!appInfo) {
        throw new Error(`Game not found: ${appID}`);
    }
    return appInfo;
}
export function saveLibraryInfo(appID, data) {
    const appPath = getLibraryPath(appID);
    fs.writeFileSync(appPath, JSON.stringify(data, null, 2));
}
export function ensureLibraryDir() {
    const libraryDir = join(__dirname, 'library');
    if (!fs.existsSync(libraryDir)) {
        fs.mkdirSync(libraryDir, { recursive: true });
    }
}
export function ensureInternalsDir() {
    const internalsDir = join(__dirname, 'internals');
    if (!fs.existsSync(internalsDir)) {
        fs.mkdirSync(internalsDir, { recursive: true });
    }
}
export function getAllLibraryFiles() {
    const libraryDir = join(__dirname, 'library');
    if (!fs.existsSync(libraryDir)) {
        return [];
    }
    const files = fs.readdirSync(libraryDir);
    const apps = [];
    for (const file of files) {
        const data = fs.readFileSync(join(libraryDir, file), 'utf-8');
        apps.push(JSON.parse(data));
    }
    return apps;
}
export function removeLibraryFile(appID) {
    const appPath = getLibraryPath(appID);
    if (fs.existsSync(appPath)) {
        fs.unlinkSync(appPath);
    }
}
export function getInternalsAppsPath() {
    return join(__dirname, 'internals/apps.json');
}
export function loadInternalsApps() {
    const appsPath = getInternalsAppsPath();
    if (!fs.existsSync(appsPath)) {
        return [];
    }
    return JSON.parse(fs.readFileSync(appsPath, 'utf-8'));
}
export function saveInternalsApps(appIDs) {
    ensureInternalsDir();
    const appsPath = getInternalsAppsPath();
    fs.writeFileSync(appsPath, JSON.stringify(appIDs, null, 2));
}
export function addToInternalsApps(appID) {
    const apps = loadInternalsApps();
    if (!apps.includes(appID)) {
        apps.push(appID);
        saveInternalsApps(apps);
    }
}
export function removeFromInternalsApps(appID) {
    const apps = loadInternalsApps();
    const index = apps.indexOf(appID);
    if (index > -1) {
        apps.splice(index, 1);
        saveInternalsApps(apps);
    }
}
//# sourceMappingURL=library.js.map