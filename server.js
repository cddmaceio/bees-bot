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

function getCsvFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    return [];
  }

  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) => file.toLowerCase().endsWith('.csv'))
    .map((file) => {
      const fullPath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(fullPath);

      return {
        name: file,
        fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
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
    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify(storageState, null, 2),
      'utf8'
    );

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

app.get('/files', (req, res) => {
  try {
    const files = getCsvFilesSorted().map((file) => ({
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      path: path.join(DOWNLOAD_DIR, file.name),
    }));

    res.json({
      ok: true,
      total: files.length,
      files,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/download-last', (req, res) => {
  try {
    const files = getCsvFilesSorted();

    if (files.length === 0) {
      return res.status(404).json({ error: 'NO_FILES_FOUND' });
    }

    const lastFile = files[0];

    return res.download(lastFile.fullPath, lastFile.name);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'DOWNLOAD_FAILED' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`bees-bot running on port ${port}`);
});