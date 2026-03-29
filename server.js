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

      return {
        name: file,
        fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
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
      failedFiles.push({
        name: file.name,
        error: error.message,
      });
    }
  }

  return {
    totalFound: files.length,
    deleted,
    deletedFiles,
    failedFiles,
  };
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

      const filled = await input.fill(dateBr, { timeout: 3000 })
        .then(() => true)
        .catch(() => false);

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

function renderHomePage() {
  const csvFiles = getCsvFilesSorted();
  const pngFiles = getPngFilesSorted();

  const lastCsv = csvFiles[0] || null;
  const lastPng = pngFiles[0] || null;

  const csvListHtml = csvFiles.length
    ? csvFiles.slice(0, 10).map((file) => `
        <tr>
          <td>${file.name}</td>
          <td>${formatBytes(file.size)}</td>
          <td>${new Date(file.mtimeMs).toLocaleString('pt-BR')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3">Nenhum CSV encontrado</td></tr>';

  const pngListHtml = pngFiles.length
    ? pngFiles.slice(0, 10).map((file) => `
        <tr>
          <td>${file.name}</td>
          <td>${formatBytes(file.size)}</td>
          <td>${new Date(file.mtimeMs).toLocaleString('pt-BR')}</td>
        </tr>
      `).join('')
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
        .container {
          max-width: 1100px;
          margin: 0 auto;
        }
        .header {
          margin-bottom: 20px;
        }
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
        .card h2 {
          margin: 0 0 12px 0;
          font-size: 18px;
        }
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
        .btn.secondary {
          background: #374151;
        }
        .btn.light {
          background: #2563eb;
        }
        .btn.danger {
          background: #dc2626;
        }
        .btn:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 10px;
          font-size: 14px;
        }
        th, td {
          text-align: left;
          border-bottom: 1px solid #e5e7eb;
          padding: 10px 8px;
        }
        .meta {
          font-size: 14px;
          line-height: 1.6;
        }
        .preview {
          width: 100%;
          max-height: 600px;
          object-fit: contain;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: white;
        }
        code {
          background: #f3f4f6;
          padding: 2px 5px;
          border-radius: 6px;
        }
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
            <div><strong>Sessão MFA:</strong> ${fs.existsSync(SESSION_FILE) ? 'OK' : 'AUSENTE'}</div>
            <div><strong>Agora:</strong> ${new Date().toLocaleString('pt-BR')}</div>
          </div>
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
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Tamanho</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                ${csvListHtml}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h2>Últimas screenshots</h2>
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Tamanho</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                ${pngListHtml}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2>Preview da última screenshot</h2>
          ${
            lastPng
              ? `<img class="preview" src="/view-debug-last" alt="Última screenshot" />`
              : '<div class="meta">Nenhuma screenshot encontrada.</div>'
          }
        </div>
      </div>

      <script>
        const runNowBtn = document.getElementById('runNowBtn');
        const deleteFilesBtn = document.getElementById('deleteFilesBtn');
        const statusBox = document.getElementById('statusBox');

        function showStatus(content) {
          statusBox.style.display = 'block';
          statusBox.textContent = typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2);
        }

        runNowBtn.addEventListener('click', async () => {
          runNowBtn.disabled = true;
          deleteFilesBtn.disabled = true;
          showStatus('Executando fluxo...');

          try {
            const response = await fetch('/run', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({})
            });

            const data = await response.json();
            showStatus(data);

            setTimeout(() => {
              window.location.reload();
            }, 1500);
          } catch (error) {
            showStatus({
              success: false,
              error: error.message || 'RUN_REQUEST_FAILED'
            });
          } finally {
            runNowBtn.disabled = false;
            deleteFilesBtn.disabled = false;
          }
        });

        deleteFilesBtn.addEventListener('click', async () => {
          const confirmed = window.confirm('Tem certeza que deseja apagar todos os CSVs e screenshots?');
          if (!confirmed) return;

          runNowBtn.disabled = true;
          deleteFilesBtn.disabled = true;
          showStatus('Apagando arquivos...');

          try {
            const response = await fetch('/delete-files', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              }
            });

            const data = await response.json();
            showStatus(data);

            setTimeout(() => {
              window.location.reload();
            }, 1200);
          } catch (error) {
            showStatus({
              success: false,
              error: error.message || 'DELETE_REQUEST_FAILED'
            });
          } finally {
            runNowBtn.disabled = false;
            deleteFilesBtn.disabled = false;
          }
        });
      </script>
    </body>
  </html>
  `;
}

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

    await gotoWithWait(page, URL_CONTROL_TOWER, 'Control Tower Inicial');

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

    let onIndicatorsPage = await waitForIndicatorsPage(page);

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

app.post('/delete-files', (_req, res) => {
  try {
    ensureDir(DOWNLOAD_DIR);

    const result = deleteManagedFiles();

    return res.json({
      success: true,
      message: 'Arquivos removidos com sucesso',
      ...result,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: error.message || 'DELETE_FILES_FAILED',
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

app.get('/files-all', (_req, res) => {
  try {
    const csvFiles = getCsvFilesSorted().map((file) => ({
      type: 'csv',
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      path: file.fullPath,
    }));

    const pngFiles = getPngFilesSorted().map((file) => ({
      type: 'png',
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      path: file.fullPath,
    }));

    const files = [...csvFiles, ...pngFiles].sort(
      (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    );

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

app.get('/view-last-csv', (_req, res) => {
  try {
    const files = getCsvFilesSorted();

    if (files.length === 0) {
      return res.status(404).send('Nenhum CSV encontrado');
    }

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

    if (files.length === 0) {
      return res.status(404).json({ error: 'NO_DEBUG_FILES_FOUND' });
    }

    return res.download(files[0].fullPath, files[0].name);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'DOWNLOAD_DEBUG_FAILED' });
  }
});

app.get('/view-debug-last', (_req, res) => {
  try {
    const files = getPngFilesSorted();

    if (files.length === 0) {
      return res.status(404).send('Nenhuma screenshot encontrada');
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${files[0].name}"`);

    return fs.createReadStream(files[0].fullPath).pipe(res);
  } catch (error) {
    console.error(error);
    return res.status(500).send('Erro ao abrir screenshot');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`bees-bot running on port ${port}`);
});