const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const SESSION_FILE = '/data/bees-profile/storageState.json';
const DOWNLOAD_DIR = '/data/downloads';

function getStorageStateIfExists() {
  return fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
}

app.get('/health', (req, res) => {
  res.send('ok');
});

app.get('/auth-status', (req, res) => {
  res.json({
    authenticated: fs.existsSync(SESSION_FILE),
    sessionFile: SESSION_FILE,
  });
});

app.post('/session', async (req, res) => {
  try {
    const storageState = req.body;

    if (!storageState || !storageState.cookies) {
      return res.status(400).json({ error: 'INVALID_STORAGE_STATE' });
    }

    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2), 'utf8');

    res.json({ ok: true, saved: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/run', async (req, res) => {
  let browser;
  let context;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    context = await browser.newContext({
      acceptDownloads: true,
      storageState: getStorageStateIfExists(),
    });

    const page = await context.newPage();

    await page.goto('https://deliver-portal.bees-platform.com/control-tower', {
      waitUntil: 'networkidle',
      timeout: 120000,
    });

    if (page.url().includes('b2clogin.com')) {
      await context.close();
      await browser.close();
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }

    const date = new Date().toISOString().slice(0, 10);

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

    await page.click('button:has-text("DOWNLOAD")');

    const download = await downloadPromise;

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const filePath = path.join(DOWNLOAD_DIR, `relatorio-${date}.csv`);
    await download.saveAs(filePath);

    await context.close();
    await browser.close();

    res.json({
      ok: true,
      file: filePath,
    });
  } catch (error) {
    console.error(error);

    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`bees-bot running on port ${port}`);
});