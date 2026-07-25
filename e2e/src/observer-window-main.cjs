const { app, BrowserWindow, screen } = require('electron');

const observerUrl = process.argv.at(-1);
if (!observerUrl?.startsWith('http://127.0.0.1:')) {
  throw new Error('A loopback Observer Window URL is required');
}

app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.max(640, Math.ceil(workArea.width / 2));
  const window = new BrowserWindow({
    x: workArea.x + Math.max(0, workArea.width - width),
    y: workArea.y,
    width,
    height: workArea.height,
    minWidth: 640,
    minHeight: 480,
    title: 'OpenGameInstaller Observer',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await window.loadURL(observerUrl);
  window.on('closed', () => app.quit());
});
