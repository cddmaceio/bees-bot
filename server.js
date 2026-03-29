const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const SESSION_FILE = process.env.SESSION_FILE || '/data/bees-profile/storageState.json';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/data/downloads';

const URL_CONTROL_TOWER = 'https://deliver-portal.bees-platform.com/control-tower';
const URL_ROUTES = 'https://deliver-portal.bees-platform.com/routes';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStorageStateIfExists() {
  return fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
}

function getCsvFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];

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

function getPngFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];

  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) => file.toLowerCase().endsWith('.png'))
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

function formatDateBR(input) {
  if (!input) {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  // aceita yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [yyyy, mm, dd] = input.split('-');
    return `${dd}/${mm}/${yyyy}`;
  }

  // aceita dd/mm/yyyy
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
    return input;
  }

  throw new Error('INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy');
}

function normalizeFileDate(input) {
  if (!input) {
    return new Date().toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
    const [dd, mm, yyyy] = input.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }

  throw new Error('INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy');
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

async function logPageState(page, label) {
  try {
    console.log(`===== ${label} =====`);
    console.log('URL atual:', page.url());
    console.log('Título:', await page.title());
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log('Trecho da página:', bodyText.slice(0, 1200));
  } catch (error) {
    console.error(`Erro ao logar estado da página [${label}]:`, error.message);
  }
}

async function detectLoginPage(page) {
  try {
    const url = page.url();
    if (url.includes('b2clogin.com')) return true;
    if (url.includes('/login')) return true;
    if (url.includes('/signin')) return true;

    const emailInputCount = await page.locator('input[type="email"]').count().catch(() => 0);
    const passwordInputCount = await page.locator('input[type="password"]').count().catch(() => 0);
    const enterCount = await page.locator('text=Entrar').count().catch(() => 0);

    return emailInputCount > 0 || passwordInputCount > 0 || enterCount > 0;
  } catch (error) {
    console.error('Erro ao detectar tela de login:', error.message);
    return false;
  }
}

async function gotoWithWait(page, url, label) {
  console.log(`Navegando para ${label}: ${url}`);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);

  await logPageState(page, label);
  await saveDebugScreenshot(page, label.toLowerCase().replace(/\s+/g, '-'));
}

async function waitForIndicatorsPage(page) {
  const title = page.locator('text=Dados para Indicadores');
  const helper = page.locator('text=Selecione uma data para baixar o arquivo CSV.');
  const button = page.locator('button:has-text("DOWNLOAD")');

  try {
    await Promise.race([
      title.waitFor({ state: 'visible', timeout: 20000 }),
      helper.waitFor({ state: 'visible', timeout: 20000 }),
    ]);

    await button.waitFor({ state: 'visible', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function findIndicatorsSection(page) {
  const candidates = [
    page.locator('div, section').filter({
      has: page.locator('text=Dados para Indicadores')
    }).first(),
    page.locator('div, section').filter({
      has: page.locator('text=Selecione uma data para baixar o arquivo CSV.')
    }).first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.count()) {
        return locator;
      }
    } catch (_) {}
  }

  return page.locator('body');
}

async function setDateField(section, dateBr) {
  const selectors = [
    'input[type="date"]',
    'input[placeholder*="dd" i]',
    'input[placeholder*="data" i]',
    'input'
  ];

  for (const selector of selectors) {
    try {
      const input = section.locator(selector).first();

      if (!(await input.count())) continue;
      if (!(await input.isVisible().catch(() => false))) continue;

      await input.scrollIntoViewIfNeeded().catch(() => {});
      await input.click({ timeout: 3000 }).catch(() => {});

      // tentativa 1
      const filled = await input.fill(dateBr, { timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      if (!filled) {
        // tentativa 2
        await input.press('Control+A').catch(() => {});
        await input.press('Meta+A').catch(() => {});
        await input.type(dateBr, { delay: 80 }).catch(() => {});
      }

      await input.press('Tab').catch(() => {});
      await sleep(700);

      console.log(`Data preenchida com seletor ${selector}: ${dateBr}`);
      return selector;
    } catch (_) {}
  }

  return null;
}

async function clickDownload(page, section, fileDate) {
  const buttonCandidates = [
    section.getByRole('button', { name: /download/i }).first(),
    section.locator('button:has-text("DOWNLOAD")').first(),
    section.locator('button:has-text("Download")').first(),
    page.getByRole('button', { name: /download/i }).first(),
    page.locator('button:has-text("DOWNLOAD")').first(),
    page.locator('button:has-text("Download")').first(),
    page.locator('a:has-text("DOWNLOAD")').first(),
    page.locator('a:has-text("Download")').first(),
  ];

  for (const btn of buttonCandidates) {
    try {
      if (!(await btn.count())) continue;
      if (!(await btn.isVisible().catch(() => false))) continue;

      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(1000);

      const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

      try {
        await btn.click({ timeout: 8000 });
      } catch {
        const box = await btn.boundingBox();
        if (!box) throw new Error('DOWNLOAD_BUTTON_NOT_CLICKABLE');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }

      const download = await downloadPromise;
      const filePath = path.join(DOWNLOAD_DIR, `relatorio-${fileDate}.csv`);
      await download.saveAs(filePath);

      return {
        filePath,
        suggestedFilename: download.suggestedFilename(),
      };
    } catch (error) {
      console.log('Falhou tentativa de clique no download:', error.message);
    }
  }

  return null;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bees-bot',
    sessionFileExists: fs.existsSync(SESSION_FILE),
    sessionFile: SESSION_FILE,
    now: new Date().toISOString(),
  });
});

app.get('/auth-status', (_req, res) => {
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
    fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2), 'utf8');

    return res.json({
      ok: true,
      saved: true,
      sessionFile: SESSION_FILE,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/run', async (req, res) => {
  let browser;
  let context;

  try {
    ensureDir(DOWNLOAD_DIR);

    const requestedDate = req.body?.date || null;
    const dateBr = formatDateBR(requestedDate);
    const fileDate = normalizeFileDate(requestedDate);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      storageState: getStorageStateIfExists(),
    });

    const page = await context.newPage();

    // 1) abre control tower direto
    await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower Inicial');

    // 2) se sessão expirou, devolve AUTH_REQUIRED
    if (await detectLoginPage(page)) {
      const loginShot = await saveDebugScreenshot(page, 'auth-required');

      await context.close().catch(() => {});
      await browser.close().catch(() => {});

      return res.status(401).json({
        success: false,
        error: 'AUTH_REQUIRED',
        currentUrl: page.url(),
        screenshot: loginShot,
      });
    }

    // 3) tenta reconhecer a página final
    let onIndicatorsPage = await waitForIndicatorsPage(page);

    // 4) fallback: routes -> control-tower
    if (!onIndicatorsPage) {
      await gotoWithWait(page, URL_ROUTES, 'Routes');

      if (await detectLoginPage(page)) {
        const loginShot = await saveDebugScreenshot(page, 'auth-required-after-routes');

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        return res.status(401).json({
          success: false,
          error: 'AUTH_REQUIRED',
          currentUrl: page.url(),
          screenshot: loginShot,
        });
      }

      await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower Final');
      onIndicatorsPage = await waitForIndicatorsPage(page);
    }

    if (!onIndicatorsPage) {
      const failShot = await saveDebugScreenshot(page, 'indicators-page-not-found');
      throw new Error(`INDICATORS_PAGE_NOT_FOUND | url=${page.url()} | screenshot=${failShot || 'N/A'}`);
    }

    // 5) preenche data
    const section = await findIndicatorsSection(page);
    const usedDateSelector = await setDateField(section, dateBr);

    if (!usedDateSelector) {
      const failShot = await saveDebugScreenshot(page, 'date-input-not-found');
      throw new Error(`DATE_INPUT_NOT_FOUND | url=${page.url()} | screenshot=${failShot || 'N/A'}`);
    }

    await sleep(1200);

    // 6) download
    const downloadResult = await clickDownload(page, section, fileDate);

    if (!downloadResult) {
      const failShot = await saveDebugScreenshot(page, 'download-button-not-found');
      throw new Error(`DOWNLOAD_BUTTON_NOT_FOUND | url=${page.url()} | screenshot=${failShot || 'N/A'}`);
    }

    const successShot = await saveDebugScreenshot(page, 'success');

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    return res.json({
      success: true,
      file: downloadResult.filePath,
      suggestedFilename: downloadResult.suggestedFilename,
      currentUrl: page.url(),
      screenshot: successShot,
      dateUsed: dateBr,
      dateSelector: usedDateSelector,
    });
  } catch (error) {
    console.error(error);

    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    return res.status(500).json({
      success: false,
      error: error.message || String(error),
    });
  }
});

app.get('/files', (_req, res) => {
  try {
    const files = getCsvFilesSorted().map((file) => ({
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      path: file.fullPath,
    }));

    return res.json({
      ok: true,
      total: files.length,
      files,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/download-last', (_req, res) => {
  try {
    const files = getCsvFilesSorted();

    if (files.length === 0) {
      return res.status(404).json({ error: 'NO_FILES_FOUND' });
    }

    return res.download(files[0].fullPath, files[0].name);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'DOWNLOAD_FAILED' });
  }
});

app.get('/download-debug-last', (_req, res) => {
  try {
    const files = getPngFilesSorted();

    if (files.length === 0) {
      return res.status(404).json({ error: 'NO_DEBUG_FILES_FOUND' });
    }

    return res.download(files[0].fullPath, files[0].name);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'DOWNLOAD_DEBUG_FAILED' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`bees-bot running on port ${port}`);
});