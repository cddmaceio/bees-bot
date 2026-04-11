const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const app = express();
app.use(express.json({ limit: '10mb' }));

const SESSION_FILE = process.env.SESSION_FILE || '/data/bees-profile/storageState.json';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/data/downloads';

// Estratégia de retenção
// CSV: 1 por dia (já acontece via nome relatorio-YYYY-MM-DD.csv)
// PNG: manter apenas a screenshot mais recente
const KEEP_ONLY_LATEST_SCREENSHOT = true;

const URL_CONTROL_TOWER = 'https://deliver-portal.bees-platform.com/control-tower';
const URL_ROUTES = 'https://deliver-portal.bees-platform.com/routes';

// ── Sessões MFA ativas ───────────────────────────────────────
const activeMfaSessions = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStorageStateIfExists() {
  return fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
}

function sanitizeFileNamePart(input) {
  return String(input || 'file')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function getCsvFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) => file.toLowerCase().endsWith('.csv'))
    .map((file) => {
      const fullPath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(fullPath);
      return { name: file, fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
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
      return { name: file, fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getManagedFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) => {
      const lower = file.toLowerCase();
      return lower.endsWith('.csv') || lower.endsWith('.png');
    })
    .map((file) => {
      const fullPath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(fullPath);
      return { name: file, fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function deleteManagedFiles() {
  const files = getManagedFilesSorted();
  let deleted = 0;
  const deletedFiles = [];
  const failedFiles = [];

  for (const file of files) {
    try {
      fs.unlinkSync(file.fullPath);
      deleted += 1;
      deletedFiles.push(file.name);
    } catch (error) {
      failedFiles.push({ name: file.name, error: error.message });
    }
  }

  return { totalFound: files.length, deleted, deletedFiles, failedFiles };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDateBR(input) {
  if (!input) {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [yyyy, mm, dd] = input.split('-');
    return `${dd}/${mm}/${yyyy}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) return input;
  throw new Error('INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy');
}

function normalizeFileDate(input) {
  if (!input) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
    const [dd, mm, yyyy] = input.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  throw new Error('INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy');
}

function cleanupOldScreenshots(keepFullPath) {
  if (!KEEP_ONLY_LATEST_SCREENSHOT) return;

  const files = getPngFilesSorted();
  for (const file of files) {
    if (file.fullPath === keepFullPath) continue;
    try {
      fs.unlinkSync(file.fullPath);
      console.log('Screenshot antiga removida:', file.fullPath);
    } catch (error) {
      console.error('Erro ao remover screenshot antiga:', file.fullPath, error.message);
    }
  }
}

async function saveDebugScreenshot(page, prefix = 'debug') {
  try {
    ensureDir(DOWNLOAD_DIR);

    const safePrefix = sanitizeFileNamePart(prefix);
    const filePath = path.join(DOWNLOAD_DIR, `${safePrefix}-${Date.now()}.png`);

    await page.screenshot({
      path: filePath,
      fullPage: true,
    });

    console.log('Screenshot salva em:', filePath);

    cleanupOldScreenshots(filePath);
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


// ── Auto Login ───────────────────────────────────────────────
const BEES_EMAIL    = process.env.BEES_EMAIL    || '';
const BEES_PASSWORD = process.env.BEES_PASSWORD || '';

async function fillVisibleInput(page, selectors, value, label) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (!await el.count()) continue;
        if (!await el.isVisible().catch(() => false)) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 3000 }).catch(() => {});
        await el.fill('', { timeout: 2000 }).catch(() => {});
        await el.fill(value, { timeout: 3000 });
        console.log(`[AUTO_LOGIN] ${label} preenchido com seletor: ${sel}`);
        return sel;
      } catch (_) {}
    }
    await sleep(500);
  }
  return null;
}

async function clickVisibleButton(page, selectors, label) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!await el.count()) continue;
      if (!await el.isVisible().catch(() => false)) continue;
      if (!await el.isEnabled().catch(() => false)) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 5000 });
      console.log(`[AUTO_LOGIN] Botão "${label}" clicado com seletor: ${sel}`);
      return true;
    } catch (_) {}
  }
  return false;
}

async function autoLogin(page, context) {
  if (!BEES_EMAIL || !BEES_PASSWORD) {
    console.warn('[AUTO_LOGIN] BEES_EMAIL ou BEES_PASSWORD não configurados.');
    return false;
  }

  try {
    console.log('[AUTO_LOGIN] Iniciando login automático para:', BEES_EMAIL);
    await saveDebugScreenshot(page, 'autologin-step1-before-email');

    // ── ETAPA 1: E-mail ──────────────────────────────────────
    const emailSelectors = [
      'input[name="email"]',
      'input[id="email"]',
      'input[type="email"]',
      'input[type="text"]',
      'input[placeholder*="e-mail" i]',
      'input[placeholder*="email" i]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input',
    ];

    const emailFilled = await fillVisibleInput(page, emailSelectors, BEES_EMAIL, 'E-mail');
    if (!emailFilled) {
      console.warn('[AUTO_LOGIN] Campo de e-mail não encontrado.');
      await saveDebugScreenshot(page, 'autologin-email-not-found');
      return false;
    }

    await sleep(400);

    const continueSelectors = [
      'button:has-text("Continuar")',
      'button:has-text("Continue")',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Próximo")',
      'button:has-text("Next")',
    ];

    const clicked1 = await clickVisibleButton(page, continueSelectors, 'Continuar (e-mail)');
    if (!clicked1) {
      console.warn('[AUTO_LOGIN] Botão Continuar (e-mail) não encontrado.');
      await saveDebugScreenshot(page, 'autologin-btn1-not-found');
      return false;
    }

    // ── ETAPA 2: Senha ───────────────────────────────────────
    console.log('[AUTO_LOGIN] Aguardando tela de senha...');
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2500);
    await saveDebugScreenshot(page, 'autologin-step2-before-password');

    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id="password"]',
      'input[name="passwd"]',
      'input[autocomplete="current-password"]',
      'input[placeholder*="senha" i]',
      'input[placeholder*="password" i]',
    ];

    const passwordFilled = await fillVisibleInput(page, passwordSelectors, BEES_PASSWORD, 'Senha');
    if (!passwordFilled) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const isMfa =
        bodyText.toLowerCase().includes('código') ||
        bodyText.toLowerCase().includes('verificação') ||
        bodyText.toLowerCase().includes('autenticador') ||
        bodyText.toLowerCase().includes('authenticator') ||
        bodyText.toLowerCase().includes('one-time') ||
        bodyText.toLowerCase().includes('otp') ||
        bodyText.toLowerCase().includes('mfa');
      console.warn(isMfa
        ? '[AUTO_LOGIN] MFA detectado — necessário login manual.'
        : `[AUTO_LOGIN] Campo de senha não encontrado. URL: ${page.url()}`
      );
      await saveDebugScreenshot(page, 'autologin-password-not-found');
      return false;
    }

    await sleep(400);

    const clicked2 = await clickVisibleButton(page, continueSelectors, 'Continuar (senha)');
    if (!clicked2) {
      console.warn('[AUTO_LOGIN] Botão Continuar (senha) não encontrado.');
      await saveDebugScreenshot(page, 'autologin-btn2-not-found');
      return false;
    }

    // ── ETAPA 3: Pós-login ───────────────────────────────────
    console.log('[AUTO_LOGIN] Aguardando redirecionamento para o portal...');
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(4000);
    await saveDebugScreenshot(page, 'autologin-step3-after-submit');

    // "Permanecer conectado?" — aceita se aparecer
    const staySelectors = [
      'button:has-text("Sim")',
      'button:has-text("Yes")',
      'input[value="Yes"]',
      'input[value="Sim"]',
      '#idSIButton9',
    ];
    for (const sel of staySelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() && await el.isVisible()) {
          await el.click();
          console.log('[AUTO_LOGIN] "Permanecer conectado?" aceito.');
          await page.waitForLoadState('networkidle').catch(() => {});
          await sleep(2000);
          break;
        }
      } catch (_) {}
    }

    const stillOnLogin = await detectLoginPage(page);
    if (stillOnLogin) {
      console.warn('[AUTO_LOGIN] Ainda na tela de login após submit. URL:', page.url());
      await saveDebugScreenshot(page, 'autologin-still-on-login');
      return false;
    }

    // Salva sessão renovada
    const storageState = await context.storageState();
    if (storageState?.cookies?.length) {
      ensureDir(path.dirname(SESSION_FILE));
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2), 'utf8');
      console.log(`[AUTO_LOGIN] Sessao salva! ${storageState.cookies.length} cookies. URL: ${page.url()}`);
    }

    return true;
  } catch (error) {
    console.error('[AUTO_LOGIN] Erro inesperado:', error.message);
    await saveDebugScreenshot(page, 'autologin-error').catch(() => {});
    return false;
  }
}

async function gotoWithWait(page, url, label) {
  console.log(`Navegando para ${label}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
    page.locator('div, section').filter({ has: page.locator('text=Dados para Indicadores') }).first(),
    page.locator('div, section').filter({ has: page.locator('text=Selecione uma data para baixar o arquivo CSV.') }).first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.count()) return locator;
    } catch (_) {}
  }

  return page.locator('body');
}

async function setDateField(section, dateBr) {
  const selectors = [
    'input[type="date"]',
    'input[placeholder*="dd" i]',
    'input[placeholder*="data" i]',
    'input',
  ];

  for (const selector of selectors) {
    try {
      const input = section.locator(selector).first();
      if (!(await input.count())) continue;
      if (!(await input.isVisible().catch(() => false))) continue;

      await input.scrollIntoViewIfNeeded().catch(() => {});
      await input.click({ timeout: 3000 }).catch(() => {});

      const filled = await input.fill(dateBr, { timeout: 3000 }).then(() => true).catch(() => false);

      if (!filled) {
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

      // Sobrescreve o CSV do mesmo dia
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

// ── Helpers MFA ──────────────────────────────────────────────
function generateSessionId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function findFreePort() {
  for (let port = 9300; port <= 9399; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(port, () => {
        srv.close();
        resolve(true);
      });
      srv.on('error', () => resolve(false));
    });

    if (free) return port;
  }

  throw new Error('Nenhuma porta livre disponível no range 9300-9399');
}

// Limpeza automática de sessões MFA antigas (> 30 min)
setInterval(() => {
  const now = Date.now();

  for (const [id, session] of activeMfaSessions.entries()) {
    if (now - session.startedAt > 30 * 60 * 1000) {
      session.browser.close().catch(() => {});
      activeMfaSessions.delete(id);
      console.log(`[MFA] Sessão expirada removida: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ── UI Principal ─────────────────────────────────────────────
function renderHomePage() {
  const csvFiles = getCsvFilesSorted();
  const pngFiles = getPngFilesSorted();
  const lastCsv = csvFiles[0] || null;
  const lastPng = pngFiles[0] || null;
  const sessionExists = fs.existsSync(SESSION_FILE);
  const mfaActive = activeMfaSessions.size > 0;
  const [mfaId] = activeMfaSessions.keys();

  const csvListHtml = csvFiles.length
    ? csvFiles.slice(0, 10).map((file) => `
        <tr>
          <td>${file.name}</td>
          <td>${formatBytes(file.size)}</td>
          <td>${new Date(file.mtimeMs).toLocaleString('pt-BR')}</td>
        </tr>`).join('')
    : '<tr><td colspan="3">Nenhum CSV encontrado</td></tr>';

  const pngListHtml = pngFiles.length
    ? pngFiles.slice(0, 10).map((file) => `
        <tr>
          <td>${file.name}</td>
          <td>${formatBytes(file.size)}</td>
          <td>${new Date(file.mtimeMs).toLocaleString('pt-BR')}</td>
        </tr>`).join('')
    : '<tr><td colspan="3">Nenhuma screenshot encontrada</td></tr>';

  return `
  <!doctype html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>BEES Bot</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f5f7fb;
          color: #1f2937;
          margin: 0;
          padding: 24px;
        }
        .container { max-width: 1100px; margin: 0 auto; }
        .header { margin-bottom: 20px; }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
          margin-bottom: 20px;
        }
        .card {
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 18px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }
        .card h2 { margin: 0 0 12px 0; font-size: 18px; }
        .btn {
          display: inline-block;
          text-decoration: none;
          background: #111827;
          color: white;
          padding: 10px 14px;
          border-radius: 8px;
          margin: 6px 8px 0 0;
          font-size: 14px;
          border: none;
          cursor: pointer;
        }
        .btn.secondary { background: #374151; }
        .btn.light { background: #2563eb; }
        .btn.danger { background: #dc2626; }
        .btn.success { background: #16a34a; }
        .btn.warning { background: #d97706; }
        .btn:disabled { opacity: 0.7; cursor: not-allowed; }
        .mfa-card {
          background: #fff;
          border: 2px solid #f59e0b;
          border-radius: 12px;
          padding: 18px;
          margin-bottom: 20px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }
        .mfa-card h2 { margin: 0 0 8px 0; font-size: 18px; color: #92400e; }
        .mfa-status {
          font-size: 13px;
          padding: 6px 12px;
          border-radius: 6px;
          margin-bottom: 10px;
        }
        .mfa-status.ok { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
        .mfa-status.missing { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
        .mfa-status.active { background: #dbeafe; color: #1e40af; border: 1px solid #bfdbfe; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
        th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 10px 8px; }
        .meta { font-size: 14px; line-height: 1.6; }
        .preview {
          width: 100%;
          max-height: 600px;
          object-fit: contain;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: white;
        }
        code { background: #f3f4f6; padding: 2px 5px; border-radius: 6px; }
        .status-box {
          margin-top: 14px;
          padding: 12px;
          border-radius: 10px;
          background: #f3f4f6;
          white-space: pre-wrap;
          font-size: 13px;
          line-height: 1.5;
          display: none;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>BEES Bot</h1>
          <div class="meta">
            <div><strong>Download dir:</strong> <code>${DOWNLOAD_DIR}</code></div>
            <div><strong>Sessão MFA:</strong> ${sessionExists ? '✅ OK' : '❌ AUSENTE'}</div>
            <div><strong>Agora:</strong> ${new Date().toLocaleString('pt-BR')}</div>
          </div>
        </div>

        <div class="mfa-card">
          <h2>🔐 Sessão MFA</h2>

          ${mfaActive
            ? `<div class="mfa-status active">⏳ Sessão MFA em andamento. Conclua o login antes de iniciar outra.</div>`
            : sessionExists
              ? `<div class="mfa-status ok">✅ StorageState disponível — bot autenticado e pronto para rodar.</div>`
              : `<div class="mfa-status missing">⚠️ Nenhuma sessão MFA salva. Faça o login para o bot funcionar.</div>`
          }

          ${mfaActive
            ? `<a class="btn warning" href="/mfa-view/${mfaId}" target="_blank">🔁 Continuar sessão MFA</a>
               <button class="btn danger" onclick="cancelarMfa('${mfaId}')">✕ Cancelar sessão</button>`
            : `<button class="btn success" id="mfaStartBtn" onclick="iniciarMfa()">🔐 Iniciar Login MFA</button>`
          }
          ${sessionExists
            ? '<button class="btn danger" id="deleteSessionBtn" onclick="apagarSessao()">Apagar sessão (teste)</button>'
            : ''
          }

          <div id="mfaStatusBox" class="status-box"></div>
        </div>

        <div class="grid">
          <div class="card">
            <h2>Ações rápidas</h2>
            <button class="btn light" id="runNowBtn">Executar agora</button>
            <button class="btn danger" id="deleteFilesBtn">Apagar arquivos/screenshots</button>
            <div style="margin-top: 12px;">
              <a class="btn" href="/health" target="_blank">Health</a>
              <a class="btn secondary" href="/auth-status" target="_blank">Auth Status</a>
              <a class="btn light" href="/files" target="_blank">CSVs (JSON)</a>
              <a class="btn light" href="/files-all" target="_blank">Todos arquivos (JSON)</a>
              <a class="btn secondary" href="/mfa-status" target="_blank">MFA Status</a>
            </div>
            <div id="statusBox" class="status-box"></div>
          </div>

          <div class="card">
            <h2>Último CSV</h2>
            <div class="meta">
              <div><strong>Arquivo:</strong> ${lastCsv ? lastCsv.name : 'Nenhum'}</div>
              <div><strong>Tamanho:</strong> ${lastCsv ? formatBytes(lastCsv.size) : '-'}</div>
              <div><strong>Modificado:</strong> ${lastCsv ? new Date(lastCsv.mtimeMs).toLocaleString('pt-BR') : '-'}</div>
            </div>
            <a class="btn" href="/download-last" target="_blank">Baixar último CSV</a>
            <a class="btn secondary" href="/view-last-csv" target="_blank">Abrir CSV no navegador</a>
          </div>

          <div class="card">
            <h2>Última screenshot</h2>
            <div class="meta">
              <div><strong>Arquivo:</strong> ${lastPng ? lastPng.name : 'Nenhuma'}</div>
              <div><strong>Tamanho:</strong> ${lastPng ? formatBytes(lastPng.size) : '-'}</div>
              <div><strong>Modificado:</strong> ${lastPng ? new Date(lastPng.mtimeMs).toLocaleString('pt-BR') : '-'}</div>
            </div>
            <a class="btn" href="/download-debug-last" target="_blank">Baixar screenshot</a>
            <a class="btn secondary" href="/view-debug-last" target="_blank">Abrir screenshot</a>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h2>Últimos CSVs</h2>
            <table>
              <thead><tr><th>Nome</th><th>Tamanho</th><th>Data</th></tr></thead>
              <tbody>${csvListHtml}</tbody>
            </table>
          </div>
          <div class="card">
            <h2>Últimas screenshots</h2>
            <table>
              <thead><tr><th>Nome</th><th>Tamanho</th><th>Data</th></tr></thead>
              <tbody>${pngListHtml}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2>Preview da última screenshot</h2>
          ${lastPng
            ? `<img class="preview" src="/view-debug-last" alt="Última screenshot" />`
            : '<div class="meta">Nenhuma screenshot encontrada.</div>'
          }
        </div>
      </div>

      <script>
        const runNowBtn = document.getElementById('runNowBtn');
        const deleteFilesBtn = document.getElementById('deleteFilesBtn');
        const statusBox = document.getElementById('statusBox');
        const mfaStatusBox = document.getElementById('mfaStatusBox');

        function showStatus(el, content) {
          el.style.display = 'block';
          el.textContent = typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2);
        }

        runNowBtn.addEventListener('click', async () => {
          runNowBtn.disabled = true;
          deleteFilesBtn.disabled = true;
          showStatus(statusBox, 'Executando fluxo...');
          try {
            const response = await fetch('/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            const data = await response.json();
            showStatus(statusBox, data);
            setTimeout(() => window.location.reload(), 1500);
          } catch (error) {
            showStatus(statusBox, { success: false, error: error.message || 'RUN_REQUEST_FAILED' });
          } finally {
            runNowBtn.disabled = false;
            deleteFilesBtn.disabled = false;
          }
        });

        deleteFilesBtn.addEventListener('click', async () => {
          if (!confirm('Tem certeza que deseja apagar todos os CSVs e screenshots?')) return;
          runNowBtn.disabled = true;
          deleteFilesBtn.disabled = true;
          showStatus(statusBox, 'Apagando arquivos...');
          try {
            const response = await fetch('/delete-files', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });
            const data = await response.json();
            showStatus(statusBox, data);
            setTimeout(() => window.location.reload(), 1200);
          } catch (error) {
            showStatus(statusBox, { success: false, error: error.message || 'DELETE_REQUEST_FAILED' });
          } finally {
            runNowBtn.disabled = false;
            deleteFilesBtn.disabled = false;
          }
        });

        async function iniciarMfa() {
          const btn = document.getElementById('mfaStartBtn');
          if (btn) btn.disabled = true;
          showStatus(mfaStatusBox, 'Iniciando sessão MFA no servidor...');
          try {
            const res = await fetch('/mfa-start', { method: 'POST' });
            const data = await res.json();
            if (data.ok) {
              showStatus(mfaStatusBox, 'Sessão iniciada! Abrindo tela de login...');
              setTimeout(() => {
                window.open(data.viewUrl, '_blank');
                window.location.reload();
              }, 800);
            } else {
              showStatus(mfaStatusBox, 'Erro: ' + (data.error || 'Falha ao iniciar'));
              if (btn) btn.disabled = false;
            }
          } catch (e) {
            showStatus(mfaStatusBox, 'Erro de conexão: ' + e.message);
            if (btn) btn.disabled = false;
          }
        }

        async function cancelarMfa(id) {
          if (!confirm('Cancelar sessão MFA?')) return;
          await fetch('/mfa-cancel/' + id, { method: 'POST' }).catch(() => {});
          window.location.reload();
        }

        async function apagarSessao() {
          if (!confirm('Apagar o storageState (sessão MFA)? O bot precisará fazer login novamente.')) return;
          const btn = document.getElementById('deleteSessionBtn');
          if (btn) btn.disabled = true;
          showStatus(mfaStatusBox, 'Apagando sessão...');
          try {
            const res = await fetch('/delete-session', { method: 'POST' });
            const data = await res.json();
            showStatus(mfaStatusBox, data.ok ? '✓ ' + data.message : 'Erro: ' + (data.error || 'Falha'));
            setTimeout(() => window.location.reload(), 1200);
          } catch (e) {
            showStatus(mfaStatusBox, 'Erro: ' + e.message);
            if (btn) btn.disabled = false;
          }
        }
      </script>
    </body>
  </html>
  `;
}

// ── Rotas principais ─────────────────────────────────────────
app.get('/', (_req, res) => {
  try {
    ensureDir(DOWNLOAD_DIR);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderHomePage());
  } catch (error) {
    console.error(error);
    return res.status(500).send('Erro ao renderizar dashboard');
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bees-bot',
    sessionFileExists: fs.existsSync(SESSION_FILE),
    sessionFile: SESSION_FILE,
    now: new Date().toISOString(),
    keepOnlyLatestScreenshot: KEEP_ONLY_LATEST_SCREENSHOT,
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

    return res.json({ ok: true, saved: true, sessionFile: SESSION_FILE });
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
    await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower Inicial');

    if (await detectLoginPage(page)) {
      console.log('[RUN] Sessao expirada. Tentando auto-login...');
      const loginOk = await autoLogin(page, context);

      if (!loginOk) {
        const loginShot = await saveDebugScreenshot(page, 'auth-required');
        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        return res.status(401).json({
          success: false,
          error: (BEES_EMAIL && BEES_PASSWORD)
            ? 'AUTH_REQUIRED — auto-login falhou. Verifique screenshots de debug ou se ha MFA pendente.'
            : 'AUTH_REQUIRED — configure BEES_EMAIL e BEES_PASSWORD no EasyPanel.',
          currentUrl: page.url(),
          screenshot: loginShot,
        });
      }

      await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower apos auto-login');
    }

    let onIndicatorsPage = await waitForIndicatorsPage(page);

    if (!onIndicatorsPage) {
      await gotoWithWait(page, URL_ROUTES, 'Routes');

      if (await detectLoginPage(page)) {
        console.log('[RUN] Sessao expirada apos Routes. Tentando auto-login...');
        const loginOk = await autoLogin(page, context);

        if (!loginOk) {
          const loginShot = await saveDebugScreenshot(page, 'auth-required-after-routes');
          await context.close().catch(() => {});
          await browser.close().catch(() => {});

          return res.status(401).json({
            success: false,
            error: 'AUTH_REQUIRED — auto-login falhou na segunda tentativa.',
            currentUrl: page.url(),
            screenshot: loginShot,
          });
        }

        await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower apos auto-login (2a vez)');
      }

      await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower Final');
      onIndicatorsPage = await waitForIndicatorsPage(page);
    }

    if (!onIndicatorsPage) {
      const failShot = await saveDebugScreenshot(page, 'indicators-page-not-found');
      throw new Error(`INDICATORS_PAGE_NOT_FOUND | url=${page.url()} | screenshot=${failShot || 'N/A'}`);
    }

    const section = await findIndicatorsSection(page);
    const usedDateSelector = await setDateField(section, dateBr);

    if (!usedDateSelector) {
      const failShot = await saveDebugScreenshot(page, 'date-input-not-found');
      throw new Error(`DATE_INPUT_NOT_FOUND | url=${page.url()} | screenshot=${failShot || 'N/A'}`);
    }

    await sleep(1200);
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
      retention: {
        csv: '1 arquivo por dia',
        screenshot: KEEP_ONLY_LATEST_SCREENSHOT ? 'apenas a mais recente' : 'sem limpeza automática',
      },
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

app.post('/delete-session', (_req, res) => {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return res.json({ ok: true, message: 'Sessão já estava ausente.' });
    }
    fs.unlinkSync(SESSION_FILE);
    console.log('[SESSION] storageState.json removido manualmente.');
    return res.json({ ok: true, message: 'Sessão removida com sucesso.' });
  } catch (error) {
    console.error('[SESSION] Erro ao remover sessão:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/delete-session', (_req, res) => {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return res.json({ ok: true, message: 'Sessao ja estava ausente.' });
    }
    fs.unlinkSync(SESSION_FILE);
    console.log('[SESSION] storageState.json removido manualmente.');
    return res.json({ ok: true, message: 'Sessao removida com sucesso.' });
  } catch (error) {
    console.error('[SESSION] Erro ao remover sessao:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/delete-files', (_req, res) => {
  try {
    ensureDir(DOWNLOAD_DIR);
    const result = deleteManagedFiles();
    return res.json({ success: true, message: 'Arquivos removidos com sucesso', ...result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message || 'DELETE_FILES_FAILED' });
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

    return res.json({ ok: true, total: files.length, files });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/files-all', (_req, res) => {
  try {
    const csvFiles = getCsvFilesSorted().map((f) => ({
      type: 'csv',
      name: f.name,
      size: f.size,
      modifiedAt: new Date(f.mtimeMs).toISOString(),
      path: f.fullPath,
    }));

    const pngFiles = getPngFilesSorted().map((f) => ({
      type: 'png',
      name: f.name,
      size: f.size,
      modifiedAt: new Date(f.mtimeMs).toISOString(),
      path: f.fullPath,
    }));

    const files = [...csvFiles, ...pngFiles].sort(
      (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    );

    return res.json({ ok: true, total: files.length, files });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/download-last', (_req, res) => {
  try {
    const files = getCsvFilesSorted();
    if (files.length === 0) return res.status(404).json({ error: 'NO_FILES_FOUND' });
    return res.download(files[0].fullPath, files[0].name);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'DOWNLOAD_FAILED' });
  }
});

app.get('/view-last-csv', (_req, res) => {
  try {
    const files = getCsvFilesSorted();
    if (files.length === 0) return res.status(404).send('Nenhum CSV encontrado');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${files[0].name}"`);

    return fs.createReadStream(files[0].fullPath).pipe(res);
  } catch (error) {
    console.error(error);
    return res.status(500).send('Erro ao abrir CSV');
  }
});

app.get('/download-debug-last', (_req, res) => {
  try {
    const files = getPngFilesSorted();
    if (files.length === 0) return res.status(404).json({ error: 'NO_DEBUG_FILES_FOUND' });
    return res.download(files[0].fullPath, files[0].name);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'DOWNLOAD_DEBUG_FAILED' });
  }
});

app.get('/view-debug-last', (_req, res) => {
  try {
    const files = getPngFilesSorted();
    if (files.length === 0) return res.status(404).send('Nenhuma screenshot encontrada');

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${files[0].name}"`);

    return fs.createReadStream(files[0].fullPath).pipe(res);
  } catch (error) {
    console.error(error);
    return res.status(500).send('Erro ao abrir screenshot');
  }
});

// ── Rotas MFA ────────────────────────────────────────────────
app.post('/mfa-start', async (_req, res) => {
  try {
    if (activeMfaSessions.size >= 1) {
      const [existingId] = activeMfaSessions.keys();
      return res.json({
        ok: true,
        sessionId: existingId,
        viewUrl: `/mfa-view/${existingId}`,
        message: 'Sessão MFA já está ativa.',
        alreadyActive: true,
      });
    }

    const port = await findFreePort();
    const sessionId = generateSessionId();

    console.log(`[MFA] Iniciando sessão ${sessionId} na porta CDP ${port}`);

    const browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=0.0.0.0',
        '--window-size=1280,900',
      ],
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    await page.goto(URL_CONTROL_TOWER, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {});

    activeMfaSessions.set(sessionId, {
      browser,
      context,
      page,
      port,
      startedAt: Date.now(),
    });

    return res.json({
      ok: true,
      sessionId,
      viewUrl: `/mfa-view/${sessionId}`,
      cdpPort: port,
    });
  } catch (error) {
    console.error('[MFA] Erro ao iniciar sessão:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/mfa-view/:id', async (req, res) => {
  const session = activeMfaSessions.get(req.params.id);

  if (!session) {
    return res.status(404).send(`
      <html><body style="font-family:monospace;padding:40px;background:#0f1117;color:#f87171">
        <h2>Sessão não encontrada ou expirada.</h2>
        <p>Volte ao painel e inicie uma nova sessão MFA.</p>
        <a href="/" style="color:#34d399">← Voltar ao painel</a>
      </body></html>
    `);
  }

  let devtoolsUrl = '';

  try {
    const targets = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${session.port}/json`, (r) => {
        let data = '';
        r.on('data', (d) => (data += d));
        r.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('JSON inválido'));
          }
        });
      }).on('error', reject);
    });

    const pageTarget = targets.find((t) => t.type === 'page');

    if (pageTarget) {
      const host = req.get('host').split(':')[0];
      devtoolsUrl = pageTarget.devtoolsFrontendUrl
        .replace(/ws=localhost/g, `ws=${host}`)
        .replace(/localhost/g, host);
    }
  } catch (e) {
    console.error('[MFA] Erro ao buscar targets CDP:', e.message);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Sessão MFA BEES</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Syne:wght@700;800&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0d14;
      --surface: #111520;
      --border: #1e2535;
      --gold: #f5c842;
      --cyan: #22d3ee;
      --green: #22c55e;
      --red: #f87171;
      --text: #e2e8f0;
      --muted: #64748b;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'JetBrains Mono', monospace;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .logo {
      font-family: 'Syne', sans-serif;
      font-size: 18px;
      font-weight: 800;
      color: var(--gold);
    }
    .logo span { color: var(--cyan); }
    .session-id { font-size: 11px; color: var(--muted); }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .btn {
      padding: 8px 18px;
      border-radius: 8px;
      border: none;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-capture { background: var(--green); color: #000; }
    .btn-capture:hover { filter: brightness(1.15); }
    .btn-capture:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-cancel { background: transparent; color: var(--red); border: 1px solid var(--red); }
    .btn-cancel:hover { background: var(--red); color: #fff; }
    .btn-back {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      border-radius: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
    }
    .btn-back:hover { color: var(--text); border-color: var(--text); }
    .status {
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 6px;
      display: none;
    }
    .status.show { display: inline-block; }
    .status.success { background: rgba(34,197,94,0.15); color: var(--green); border: 1px solid rgba(34,197,94,0.3); }
    .status.error { background: rgba(248,113,113,0.15); color: var(--red); border: 1px solid rgba(248,113,113,0.3); }
    .status.loading { background: rgba(34,211,238,0.1); color: var(--cyan); border: 1px solid rgba(34,211,238,0.2); }
    .instructions { font-size: 12px; color: var(--muted); }
    .instructions strong { color: var(--gold); }
    .viewer-wrap { flex: 1; overflow: hidden; position: relative; }
    iframe { width: 100%; height: 100%; border: none; background: #fff; }
    .no-devtools {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      color: var(--muted);
      text-align: center;
    }
    .no-devtools h3 { color: var(--text); }
    .pulse {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 1.5s infinite;
      flex-shrink: 0;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
    .timer { font-size: 11px; color: var(--muted); margin-left: auto; }
  </style>
</head>
<body>
  <header>
    <div class="logo">BEES<span>Bot</span> · Sessão MFA</div>
    <div class="session-id">ID: ${req.params.id}</div>
  </header>

  <div class="toolbar">
    <a href="/" class="btn-back">← Painel</a>

    <div style="display:flex;align-items:center;gap:6px">
      <div class="pulse"></div>
      <span style="font-size:12px;color:var(--green)">Sessão ativa</span>
    </div>

    <div class="instructions">
      <strong>1.</strong> Faça o login MFA abaixo &nbsp;&nbsp;
      <strong>2.</strong> Após entrar no portal, clique em Capturar
    </div>

    <button class="btn btn-capture" id="captureBtn" onclick="capturar()">✓ Capturar sessão</button>
    <button class="btn btn-cancel" onclick="cancelar()">✕ Cancelar</button>
    <span class="status" id="status"></span>
    <span class="timer" id="timer">00:00</span>
  </div>

  <div class="viewer-wrap">
    ${devtoolsUrl
      ? `<iframe src="${devtoolsUrl}" allow="*" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>`
      : `<div class="no-devtools">
          <h3>⚠️ Viewer ainda não disponível</h3>
          <p>O browser está inicializando no servidor.</p>
          <p>Aguarde alguns segundos e recarregue.</p>
          <button class="btn btn-capture" onclick="location.reload()" style="margin-top:8px">↻ Recarregar</button>
        </div>`
    }
  </div>

  <script>
    const sessionId = '${req.params.id}';
    const startedAt = Date.now();

    setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      document.getElementById('timer').textContent = mm + ':' + ss;
    }, 1000);

    function setStatus(msg, type) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status show ' + type;
    }

    async function capturar() {
      const btn = document.getElementById('captureBtn');
      btn.disabled = true;
      setStatus('Capturando sessão...', 'loading');

      try {
        const res = await fetch('/mfa-capture/' + sessionId, { method: 'POST' });
        const data = await res.json();

        if (data.ok) {
          setStatus('✓ Sessão salva! Redirecionando...', 'success');
          setTimeout(() => { window.location.href = '/'; }, 1800);
        } else {
          setStatus('Erro: ' + (data.error || 'Falha ao capturar'), 'error');
          btn.disabled = false;
        }
      } catch (e) {
        setStatus('Erro: ' + e.message, 'error');
        btn.disabled = false;
      }
    }

    async function cancelar() {
      if (!confirm('Cancelar sessão MFA?')) return;
      await fetch('/mfa-cancel/' + sessionId, { method: 'POST' }).catch(() => {});
      window.location.href = '/';
    }
  </script>
</body>
</html>
  `);
});

app.post('/mfa-capture/:id', async (req, res) => {
  const session = activeMfaSessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'SESSION_NOT_FOUND' });

  try {
    console.log(`[MFA] Capturando storageState da sessão ${req.params.id}`);
    const storageState = await session.context.storageState();

    if (!storageState?.cookies?.length) {
      return res.status(400).json({
        ok: false,
        error: 'EMPTY_STORAGE_STATE — Você já fez o login no portal?',
      });
    }

    ensureDir(path.dirname(SESSION_FILE));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2), 'utf8');
    console.log(`[MFA] storageState salvo: ${storageState.cookies.length} cookies`);

    await session.browser.close().catch(() => {});
    activeMfaSessions.delete(req.params.id);

    return res.json({
      ok: true,
      saved: SESSION_FILE,
      cookies: storageState.cookies.length,
      origins: storageState.origins?.length || 0,
    });
  } catch (error) {
    console.error('[MFA] Erro ao capturar:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/mfa-cancel/:id', async (req, res) => {
  const session = activeMfaSessions.get(req.params.id);
  if (!session) return res.json({ ok: true, message: 'Sessão já encerrada' });

  await session.browser.close().catch(() => {});
  activeMfaSessions.delete(req.params.id);
  console.log(`[MFA] Sessão ${req.params.id} cancelada`);

  return res.json({ ok: true });
});

app.get('/mfa-status', (_req, res) => {
  const sessions = [...activeMfaSessions.entries()].map(([id, s]) => ({
    id,
    startedAt: new Date(s.startedAt).toISOString(),
    ageMinutes: Math.floor((Date.now() - s.startedAt) / 60000),
    cdpPort: s.port,
    viewUrl: `/mfa-view/${id}`,
  }));

  return res.json({
    ok: true,
    activeSessions: sessions.length,
    sessions,
    sessionFileExists: fs.existsSync(SESSION_FILE),
  });
});

// ── Start ────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`bees-bot running on port ${port}`);
});