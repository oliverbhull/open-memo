/** Run: node_modules/.bin/electron --disable-gpu scripts/promo/render.cjs
 * Creates sanitized screenshots using the real React components and isolated sample data.
 * No application database, microphone, networking service, or personal data is used.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root, plugins: [(await import('@vitejs/plugin-react')).default()], server: { host: '127.0.0.1', port: 5198, strictPort: true } });
  const icons = {};
  const { execFileSync } = require('node:child_process');
  const temp = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'memo-promo-'));
  const iconPaths = { Slack: '/Applications/Slack.app/Contents/Resources/electron.icns', Mail: '/System/Applications/Mail.app/Contents/Resources/ApplicationIcon.icns', Safari: '/Applications/Safari.app/Contents/Resources/AppIcon.icns', Cursor: '/Applications/Cursor.app/Contents/Resources/Cursor.icns' };
  for (const [name, file] of Object.entries(iconPaths)) {
    try {
      const output = path.join(temp, name + '.png');
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', file, '--out', output], { stdio: 'ignore', timeout: 5000 });
      icons[name] = 'data:image/png;base64,' + (await fs.readFile(output)).toString('base64');
    } catch { /* AppIcon provides its normal initials fallback. */ }
  }
  await fs.rm(temp, { recursive: true, force: true });
  await fs.writeFile(path.join(__dirname, 'icons.json'), JSON.stringify(icons));
  await server.listen();
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('Renderer:', ...args); });
  win.webContents.on('render-process-gone', (_, details) => console.error(details));
  try {
    for (const view of ['hero', 'activity', 'history', 'writing', 'snippets']) {
      for (const raw of [false, true]) {
        if (view === 'hero' && raw) continue;
        win.setContentSize(raw ? 860 : 1600, raw ? (view === 'writing' ? 740 : 620) : view === 'hero' ? 900 : 1000);
        await win.loadURL(`http://127.0.0.1:5198/scripts/promo/index.html?view=${view}${raw ? '&raw=1' : ''}`);
        for (let i = 0; i < 40; i++) { if (await win.webContents.executeJavaScript('window.promoReady === true')) break; await new Promise(r => setTimeout(r, 100)); }
        const status = await win.webContents.executeJavaScript(`({ready: window.promoReady, error: document.body.innerText.includes('Something went wrong'), text: document.querySelector('.product-window')?.innerText})`);
        if (!status.ready || status.error || !status.text?.includes(view === 'history' ? 'onboarding' : 'Activity')) throw new Error(JSON.stringify(status));
        await new Promise(r => setTimeout(r, 250));
        const image = await win.webContents.capturePage();
        const filename = `${view}${raw ? '-screenshot' : ''}.png`;
        await fs.writeFile(path.join(root, 'assets/readme/promo', filename), image.toPNG());
        console.log(filename, image.getSize());
      }
    }
  } finally { win.destroy(); await server.close(); await fs.unlink(path.join(__dirname, 'icons.json')); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
