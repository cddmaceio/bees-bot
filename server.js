const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BASE_URL = 'https://deliver-portal.bees-platform.com';
const LOGIN_URL = `${BASE_URL}/login`;
const TARGET_URL = `${BASE_URL}/control-tower`;

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/data/downloads';
const USER_EMAIL = process.env.BEES_EMAIL || '';
const USER_PASSWORD = process.env.BEES_PASSWORD || '';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDateBR(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function todayFileName(prefix = 'bees-control-tower') {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${prefix}-${yyyy}-${mm}-${dd}.csv`;
}

async function saveDebugScreenshot(page, namePrefix = 'debug') {
  ensureDir(DOWNLOAD_DIR);
  const file = path.join(DOWNLOAD_DIR, `${namePrefix}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

async function findFirstVisible(page, selectors, timeout = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count()) {
          const visible = await locator.isVisible().catch(() => false);
          if (visible) return locator;
        }
      } catch (_) {}
    }
    await sleep(500);
  }

  return null;
}

async function doLogin(page) {
  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await sleep(2500);

  const emailCandidates = [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="email" i]',
  ];

  const passwordCandidates = [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="senha" i]',
    'input[placeholder*="password" i]',
  ];

  let emailFilled = false;
  for (const selector of emailCandidates) {
    try {
      const el = page.locator(selector).first();
      if (await el.count()) {
        await el.fill(USER_EMAIL, { timeout: 3000 });
        emailFilled = true;
        break;
      }
    } catch (_) {}
  }

  let passwordFilled = false;
  for (const selector of passwordCandidates) {
    try {
      const el = page.locator(selector).first();
      if (await el.count()) {
        await el.fill(USER_PASSWORD, { timeout: 3000 });
        passwordFilled = true;
        break;
      }
    } catch (_) {}
  }

  if (!emailFilled || !passwordFilled) {
    const shot = await saveDebugScreenshot(page, 'login-fields-not-found');
    throw new Error(`LOGIN_FIELDS_NOT_FOUND | screenshot=${shot}`);
  }

  const loginButton = await findFirstVisible(page, [
    'button:has-text("Entrar")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button[type="submit"]',
    'input[type="submit"]'
  ], 10000);

  if (!loginButton) {
    const shot = await saveDebugScreenshot(page, 'login-button-not-found');
    throw new Error(`LOGIN_BUTTON_NOT_FOUND | screenshot=${shot}`);
  }

  await loginButton.click({ timeout: 10000 }).catch(async () => {
    const box = await loginButton.boundingBox();
    if (!box) {
      const shot = await saveDebugScreenshot(page, 'login-button-click-failed');
      throw new Error(`LOGIN_BUTTON_CLICK_FAILED | screenshot=${shot}`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });

  await sleep(6000);
}

async function navigateToControlTower(page) {
  await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(3000);
}

async function waitControlTowerReady(page) {
  const anchors = [
    'text=Dados para Indicadores',
    'text=Selecione uma data para baixar o arquivo CSV.',
    'button:has-text("DOWNLOAD")',
    'button:has-text("Download")',
    'input[placeholder*="dd" i]',
    'input[type="text"]'
  ];

  const found = await findFirstVisible(page, anchors, 30000);
  if (!found) {
    const shot = await saveDebugScreenshot(page, 'control-tower-not-ready');
    throw new Error(`CONTROL_TOWER_NOT_READY | url=${page.url()} | screenshot=${shot}`);
  }
}

async function findSection(page) {
  const sectionCandidates = [
    page.locator('div, section').filter({
      has: page.locator('text=Dados para Indicadores')
    }).first(),

    page.locator('div, section').filter({
      has: page.locator('text=Selecione uma data para baixar o arquivo CSV.')
    }).first(),
  ];

  for (const section of sectionCandidates) {
    try {
      if (await section.count()) return section;
    } catch (_) {}
  }

  return page.locator('body');
}

async function setDateInSection(section, dateStr) {
  const inputCandidates = [
    'input[type="date"]',
    'input[placeholder*="dd" i]',
    'input[placeholder*="data" i]',
    'input'
  ];

  for (const selector of inputCandidates) {
    try {
      const input = section.locator(selector).first();
      if (await input.count()) {
        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click({ timeout: 3000 }).catch(() => {});
        await input.fill(dateStr, { timeout: 5000 }).catch(async () => {
          await input.press('Control+A').catch(() => {});
          await input.press('Meta+A').catch(() => {});
          await input.type(dateStr, { delay: 80 }).catch(() => {});
        });
        await sleep(500);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function findDownloadButton(section, page) {
  const candidates = [
    section.getByRole('button', { name: /download/i }).first(),
    section.locator('button:has-text("DOWNLOAD")').first(),
    section.locator('button:has-text("Download")').first(),
    page.getByRole('button', { name: /download/i }).first(),
    page.locator('button:has-text("DOWNLOAD")').first(),
    page.locator('button:has-text("Download")').first(),
  ];

  for (const btn of candidates) {
    try {
      if (await btn.count()) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) return btn;
      }
    } catch (_) {}
  }

  return null;
}

async function clickDownloadAndSave(page, requestedDate) {
  await waitControlTowerReady(page);

  const section = await findSection(page);

  const dateValue = requestedDate || formatDateBR(new Date());
  const dateSet = await setDateInSection(section, dateValue);

  if (!dateSet) {
    const shot = await saveDebugScreenshot(page, 'date-input-not-found');
    throw new Error(`DATE_INPUT_NOT_FOUND | url=${page.url()} | screenshot=${shot}`);
  }

  await sleep(1200);

  const downloadBtn = await findDownloadButton(section, page);

  if (!downloadBtn) {
    const shot = await saveDebugScreenshot(page, 'download-button-not-found');
    throw new Error(`DOWNLOAD_BUTTON_NOT_FOUND | url=${page.url()} | screenshot=${shot}`);
  }

  await downloadBtn.scrollIntoViewIfNeeded().catch(() => {});
  await downloadBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await sleep(1000);

  ensureDir(DOWNLOAD_DIR);

  const targetFile = path.join(DOWNLOAD_DIR, todayFileName());

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

  try {
    await downloadBtn.click({ timeout: 10000 });
  } catch (_) {
    const box = await downloadBtn.boundingBox();
    if (!box) {
      const shot = await saveDebugScreenshot(page, 'download-click-failed');
      throw new Error(`DOWNLOAD_CLICK_FAILED | screenshot=${shot}`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  const download = await downloadPromise.catch(async () => {
    const shot = await saveDebugScreenshot(page, 'download-event-timeout');
    throw new Error(`DOWNLOAD_EVENT_TIMEOUT | screenshot=${shot}`);
  });

  await download.saveAs(targetFile);

  return {
    savedAs: targetFile,
    suggestedFilename: download.suggestedFilename(),
    dateUsed: dateValue,
  };
}

async function runBot({ date }) {
  if (!USER_EMAIL || !USER_PASSWORD) {
    throw new Error('MISSING_CREDENTIALS');
  }

  ensureDir(DOWNLOAD_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  try {
    await doLogin(page);
    await navigateToControlTower(page);

    const result = await clickDownloadAndSave(page, date);

    const shot = await saveDebugScreenshot(page, 'success');
    return {
      success: true,
      currentUrl: page.url(),
      screenshot: shot,
      ...result,
    };
  } catch (error) {
    const shot = await saveDebugScreenshot(page, 'run-error');
    return {
      success: false,
      error: error.message || String(error),
      currentUrl: page.url(),
      screenshot: shot,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'bees-bot',
    target: TARGET_URL,
    now: new Date().toISOString(),
  });
});

app.post('/run', async (req, res) => {
  try {
    const { date } = req.body || {};
    const result = await runBot({ date });
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`bees-bot listening on port ${PORT}`);
});