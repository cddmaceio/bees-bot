const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const SESSION_FILE =
  process.env.SESSION_FILE ||
  '/data/bees-profile/storageState.json';

const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR ||
  '/data/downloads';

const URL_CONTROL_TOWER =
  'https://deliver-portal.bees-platform.com/control-tower';

const URL_ROUTES =
  'https://deliver-portal.bees-platform.com/routes';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function getStorageStateIfExists() {
  return fs.existsSync(SESSION_FILE)
    ? SESSION_FILE
    : undefined;
}

function getCsvFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR))
    return [];

  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) =>
      file.toLowerCase().endsWith('.csv')
    )
    .map((file) => {
      const fullPath = path.join(
        DOWNLOAD_DIR,
        file
      );

      const stats =
        fs.statSync(fullPath);

      return {
        name: file,
        fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    })
    .sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs
    );
}

function getPngFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR))
    return [];

  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) =>
      file.toLowerCase().endsWith('.png')
    )
    .map((file) => {
      const fullPath = path.join(
        DOWNLOAD_DIR,
        file
      );

      const stats =
        fs.statSync(fullPath);

      return {
        name: file,
        fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    })
    .sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs
    );
}

function getManagedFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR))
    return [];

  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((file) => {
      const lower =
        file.toLowerCase();

      return (
        lower.endsWith('.csv') ||
        lower.endsWith('.png')
      );
    })
    .map((file) => {
      const fullPath = path.join(
        DOWNLOAD_DIR,
        file
      );

      const stats =
        fs.statSync(fullPath);

      return {
        name: file,
        fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    })
    .sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs
    );
}

function deleteManagedFiles() {
  const files =
    getManagedFilesSorted();

  let deleted = 0;

  const deletedFiles = [];

  for (const file of files) {
    try {
      fs.unlinkSync(
        file.fullPath
      );

      deleted++;

      deletedFiles.push(
        file.name
      );
    } catch (error) {
      console.error(
        error.message
      );
    }
  }

  return {
    totalFound:
      files.length,
    deleted,
    deletedFiles,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024)
    return bytes + ' B';

  if (bytes < 1024 * 1024)
    return (
      (
        bytes / 1024
      ).toFixed(1) + ' KB'
    );

  return (
    (
      bytes /
      (1024 * 1024)
    ).toFixed(1) + ' MB'
  );
}

function formatDateBR(input) {
  if (!input) {
    const d = new Date();

    const dd = String(
      d.getDate()
    ).padStart(2, '0');

    const mm = String(
      d.getMonth() + 1
    ).padStart(2, '0');

    const yyyy =
      d.getFullYear();

    return (
      dd +
      '/' +
      mm +
      '/' +
      yyyy
    );
  }

  return input;
}

function normalizeFileDate(
  input
) {
  if (!input) {
    return new Date()
      .toISOString()
      .slice(0, 10);
  }

  return input;
}

async function saveDebugScreenshot(
  page,
  prefix = 'debug'
) {
  ensureDir(
    DOWNLOAD_DIR
  );

  const filePath =
    path.join(
      DOWNLOAD_DIR,
      prefix +
        '-' +
        Date.now() +
        '.png'
    );

  await page.screenshot({
    path: filePath,
    fullPage: true,
  });

  return filePath;
}

async function detectLoginPage(
  page
) {
  const url =
    page.url();

  if (
    url.includes(
      'b2clogin.com'
    )
  )
    return true;

  if (
    url.includes('/login')
  )
    return true;

  return false;
}

async function gotoWithWait(
  page,
  url,
  label
) {
  console.log(
    'Navegando:',
    label
  );

  await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout: 120000,
    }
  );

  await page.waitForTimeout(
    4000
  );

  await saveDebugScreenshot(
    page,
    label
  );
}

function renderHomePage() {
  const csvFiles =
    getCsvFilesSorted();

  const pngFiles =
    getPngFilesSorted();

  const lastCsv =
    csvFiles[0];

  const lastPng =
    pngFiles[0];

  return `
<!doctype html>
<html>
<head>
<title>BEES Bot</title>
<style>
body {
font-family: Arial;
padding: 24px;
background: #f5f7fb;
}

.btn {
padding: 10px 14px;
border-radius: 8px;
border: none;
cursor: pointer;
margin-right: 8px;
}

.run {
background: #2563eb;
color: white;
}

.delete {
background: #dc2626;
color: white;
}
</style>
</head>

<body>

<h1>BEES Bot</h1>

<button class="btn run" id="run">
Executar agora
</button>

<button class="btn delete" id="delete">
Apagar arquivos
</button>

<script>

const runBtn =
document.getElementById("run");

const deleteBtn =
document.getElementById("delete");

runBtn.onclick =
async () => {

runBtn.disabled = true;

await fetch("/run", {
method: "POST"
});

location.reload();

};

deleteBtn.onclick =
async () => {

if (!confirm("Apagar arquivos?"))
return;

deleteBtn.disabled = true;

await fetch("/delete-files", {
method: "POST"
});

location.reload();

};

</script>

</body>
</html>
`;
}

app.get(
  '/',
  (req, res) => {
    res.send(
      renderHomePage()
    );
  }
);

app.post(
  '/run',
  async (req, res) => {
    let browser;
    let context;

    try {
      ensureDir(
        DOWNLOAD_DIR
      );

      browser =
        await chromium.launch(
          {
            headless: true,
          }
        );

      context =
        await browser.newContext(
          {
            acceptDownloads: true,
            storageState:
              getStorageStateIfExists(),
          }
        );

      const page =
        await context.newPage();

      await gotoWithWait(
        page,
        URL_CONTROL_TOWER,
        'control'
      );

      if (
        await detectLoginPage(
          page
        )
      ) {
        const shot =
          await saveDebugScreenshot(
            page,
            'login'
          );

        return res
          .status(401)
          .json({
            error:
              'AUTH_REQUIRED',
            screenshot:
              shot,
          });
      }

      const shot =
        await saveDebugScreenshot(
          page,
          'success'
        );

      await browser.close();

      res.json({
        success: true,
        screenshot:
          shot,
      });
    } catch (error) {
      console.error(
        error
      );

      if (browser)
        await browser.close();

      res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.post(
  '/delete-files',
  (req, res) => {
    const result =
      deleteManagedFiles();

    res.json({
      success: true,
      result,
    });
  }
);

const port =
  process.env.PORT || 3000;

app.listen(
  port,
  () => {
    console.log(
      `bees-bot running on port ${port}`
    );
  }
);