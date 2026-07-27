const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');

const [observerUrl, resultPath] = process.argv.slice(-2);
if (!observerUrl || !resultPath)
  throw new Error('Observer URL and result path are required');
const requireFromE2e = createRequire(`${process.cwd()}/package.json`);
const axeSource = readFileSync(
  requireFromE2e.resolve('axe-core/axe.min.js'),
  'utf8'
);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await window.loadURL(observerUrl);
  await window.webContents.executeJavaScript(axeSource);
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const options = {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
      };
      const waitForLiveService = async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const control = document.querySelector('input[value="live-service"]');
          if (control) return control;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Observer live-service control did not appear');
      };
      const deterministic = await axe.run(document, options);
      const liveService = await waitForLiveService();
      liveService.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const live = await axe.run(document, options);
      return [...deterministic.violations, ...live.violations];
    })()
  `);
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  await window.close();
  await app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
