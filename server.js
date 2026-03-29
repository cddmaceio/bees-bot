const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();

app.get('/health', (req, res) => {
  res.send('ok');
});

app.post('/run', async (req, res) => {
  try {
    const context = await chromium.launchPersistentContext('/data/bees-profile', {
      headless: true,
      acceptDownloads: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await context.newPage();

    await page.goto('https://deliver-portal.bees-platform.com/control-tower', {
      waitUntil: 'networkidle',
      timeout: 120000,
    });

    if (page.url().includes('b2clogin.com')) {
      await context.close();
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }

    const date = new Date().toISOString().slice(0, 10);

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

    await page.click('button:has-text("DOWNLOAD")');

    const download = await downloadPromise;

    const filePath = path.join('/data/downloads', `relatorio-${date}.csv`);
    await download.saveAs(filePath);

    await context.close();

    res.json({ ok: true, file: filePath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('bees-bot running on port 3000');
});