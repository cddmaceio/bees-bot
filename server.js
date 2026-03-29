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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

async function saveDebugScreenshot(page, prefix = 'debug') {
  try {
    ensureDir(DOWNLOAD_DIR);
    const filePath = path.join(DOWNLOAD_DIR, `${prefix}-${Date.now()}.png`);
    await page.screenshot({
      path: filePath,
      fullPage: true,
    });
    console.log('Screenshot salva em:', filePath);
    return filePath;
  } catch (error) {
    console.error('Erro ao salvar screenshot:', error.message);
    return null;
  }
}

async function detectLoginPage(page) {
  try {
    const byUrl = page.url().includes('b2clogin.com');

    const enterCount = await page
      .locator('text=Entrar')
      .count()
      .catch(() => 0);

    const emailInputCount = await page
      .locator('input[type="email"]')
      .count()
      .catch(() => 0);

    return byUrl || enterCount > 0 || emailInputCount > 0;
  } catch (error) {
    console.error('Erro ao detectar tela de login:', error.message);
    return false;
  }
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

    ensureDir(path.dirname(SESSION_FILE));
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
    ensureDir(DOWNLOAD_DIR);

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
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);

    console.log('URL atual:', page.url());
    console.log('Título da página:', await page.title());

    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log('Trecho da página:', bodyText.slice(0, 1000));

    const debugScreenshot = await saveDebugScreenshot(page, 'before-download');

    const onLoginPage = await detectLoginPage(page);

    if (onLoginPage) {
      await context.close();
      await browser.close();

      return res.status(401).json({
        error: 'AUTH_REQUIRED',
        currentUrl: page.url(),
        screenshot: debugScreenshot,
      });
    }

    const date = new Date().toISOString().slice(0, 10);

    console.log('Aguardando botão de download...');

    const selectors = [
      'button:has-text("DOWNLOAD")',
      'button:has-text("Download")',
      'button:has-text("Baixar")',
      'button:has-text("Export")',
      'button:has-text("Exportar")',
      'button:has-text("Baixar CSV")',
      '[data-testid="download"]',
      'a:has-text("DOWNLOAD")',
      'a:has-text("Download")',
    ];

    let filePath = null;
    let matchedSelector = null;

    for (const selector of selectors) {
      try {
        const btn = page.locator(selector).first();

        await btn.waitFor({
          state: 'visible',
          timeout: 5000,
        });

        console.log('Botão encontrado com seletor:', selector);

        const downloadPromise = page.waitForEvent('download', {
          timeout: 60000,
        });

        await btn.click();

        const download = await downloadPromise;

        filePath = path.join(DOWNLOAD_DIR, `relatorio-${date}.csv`);
        await download.saveAs(filePath);

        matchedSelector = selector;
        console.log('Arquivo salvo em:', filePath);

        break;
      } catch (error) {
        console.log('Tentativa falhou para seletor:', selector);
      }
    }

    if (!filePath) {
      const failScreenshot = await saveDebugScreenshot(page, 'download-not-found');

      throw new Error(
        `DOWNLOAD_BUTTON_NOT_FOUND | url=${page.url()} | screenshot=${failScreenshot || 'N/A'}`
      );
    }

    await context.close();
    await browser.close();

    res.json({
      ok: true,
      file: filePath,
      selector: matchedSelector,
      screenshot: debugScreenshot,
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

app.get('/download-debug-last', (req, res) => {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      return res.status(404).json({ error: 'NO_DEBUG_FILES_FOUND' });
    }

    const files = fs
      .readdirSync(DOWNLOAD_DIR)
      .filter((file) => file.toLowerCase().endsWith('.png'))
      .map((file) => {
        const fullPath = path.join(DOWNLOAD_DIR, file);
        const stats = fs.statSync(fullPath);

        return {
          name: file,
          fullPath,
          mtimeMs: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (files.length === 0) {
      return res.status(404).json({ error: 'NO_DEBUG_FILES_FOUND' });
    }

    const lastFile = files[0];
    return res.download(lastFile.fullPath, lastFile.name);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'DOWNLOAD_DEBUG_FAILED' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`bees-bot running on port ${port}`);
});