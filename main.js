const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  Tray,
  nativeImage
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const ffmpegStaticPath = require("ffmpeg-static");
const JSZip = require("jszip");
const APP_MANIFEST_PATH = path.join(__dirname, "app.manifest.json");
const REQUIRED_MANIFEST_FIELDS = [
  "id",
  "name",
  "version",
  "shortDescription",
  "aiDescription",
  "github",
  "releaseApiUrl"
];

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".m4v",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".3gp",
  ".ts",
  ".mts",
  ".m2ts",
  ".ogv",
  ".ogm",
  ".qt",
  ".asf",
  ".vob",
  ".mxf",
  ".f4v",
  ".rm",
  ".rmvb",
  ".divx"
]);

let mainWindow = null;
let tray = null;
let cancelRequested = false;
let isQuitting = false;

app.setName("gift-converter");

function validateAppManifest() {
  if (app.isPackaged) {
    return;
  }

  try {
    const raw = fs.readFileSync(APP_MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw);
    const missing = REQUIRED_MANIFEST_FIELDS.filter((field) => {
      const value = manifest[field];
      return value === undefined || value === null || value === "";
    });

    if (missing.length > 0) {
      console.warn(
        `[app.manifest] Missing required fields: ${missing.join(", ")}`
      );
    }
  } catch (error) {
    console.warn(`[app.manifest] Validation skipped: ${error.message}`);
  }
}

function getAppIconPath() {
  return path.join(__dirname, "assets", "icon.ico");
}

function getFfmpegExecutablePath() {
  if (!ffmpegStaticPath) {
    throw new Error("ffmpeg-static path could not be resolved.");
  }

  if (!app.isPackaged) {
    return ffmpegStaticPath;
  }

  return ffmpegStaticPath.replace("app.asar", "app.asar.unpacked");
}

function createTrayIcon() {
  return nativeImage.createFromPath(getAppIconPath()).resize({
    width: 16,
    height: 16,
    quality: "best"
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("gift-converter");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open",
        click: () => showMainWindow()
      },
      {
        type: "separator"
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1140,
    minHeight: 760,
    backgroundColor: "#f3ede2",
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walkDirectory(dirPath, collected = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(fullPath, collected);
      continue;
    }

    if (entry.isFile() && isVideoFile(fullPath)) {
      collected.push(fullPath);
    }
  }

  return collected;
}

async function selectVideoFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Video Files",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Video",
        extensions: Array.from(VIDEO_EXTENSIONS).map((ext) => ext.slice(1))
      }
    ]
  });

  if (result.canceled) {
    return [];
  }

  return result.filePaths;
}

async function selectVideoFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Folder to Scan",
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }

  return walkDirectory(result.filePaths[0]);
}

async function selectOutputFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Output Folder",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

async function pickZipDestination(outputDir) {
  const defaultPath = path.join(
    outputDir || app.getPath("documents"),
    "gift-converter-export.zip"
  );
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save ZIP File",
    defaultPath,
    filters: [
      {
        name: "ZIP",
        extensions: ["zip"]
      }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
}

async function saveGifFileAs({ sourcePath, suggestedName, outputDir } = {}) {
  const defaultName = suggestedName || path.basename(sourcePath || "export.gif");
  const defaultPath = path.join(outputDir || app.getPath("documents"), defaultName);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save GIF File",
    defaultPath,
    filters: [
      {
        name: "GIF",
        extensions: ["gif"]
      }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { cancelled: true };
  }

  const sourceResolved = path.resolve(sourcePath);
  const destinationResolved = path.resolve(result.filePath);
  if (sourceResolved !== destinationResolved) {
    fs.copyFileSync(sourceResolved, destinationResolved);
  }

  return {
    cancelled: false,
    filePath: destinationResolved
  };
}

function normalizeDropPaths(inputPaths = []) {
  const files = [];

  for (const inputPath of inputPaths) {
    if (!inputPath || !fs.existsSync(inputPath)) {
      continue;
    }

    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      walkDirectory(inputPath, files);
      continue;
    }

    if (stat.isFile() && isVideoFile(inputPath)) {
      files.push(inputPath);
    }
  }

  return Array.from(new Set(files));
}

function previewPathForVideo(filePath) {
  const previewsDir = path.join(os.tmpdir(), "bulk-gif-previews");
  fs.mkdirSync(previewsDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(filePath).digest("hex");
  return path.join(previewsDir, `${hash}.jpg`);
}

function generatePreviewForVideo(filePath) {
  return new Promise((resolve) => {
    const outputPath = previewPathForVideo(filePath);
    if (fs.existsSync(outputPath)) {
      resolve(pathToFileURL(outputPath).href);
      return;
    }

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "0.10",
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=84:-1:flags=lanczos",
      outputPath
    ];
    const child = spawn(getFfmpegExecutablePath(), args, { windowsHide: true });

    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(pathToFileURL(outputPath).href);
        return;
      }
      resolve("");
    });

    child.on("error", () => resolve(""));
  });
}

async function generateVideoPreviews(paths = []) {
  return Promise.all(
    paths.map(async (inputPath) => ({
      inputPath,
      previewUrl: await generatePreviewForVideo(inputPath)
    }))
  );
}

function getFileEntries(filePaths = []) {
  return filePaths
    .filter((filePath) => filePath && fs.existsSync(filePath))
    .map((filePath) => ({
      filePath,
      fileName: path.basename(filePath),
      sizeBytes: fs.statSync(filePath).size
    }));
}

function buildArchiveEntries(files = []) {
  const usedNames = new Set();

  return files
    .filter((filePath) => filePath && fs.existsSync(filePath))
    .map((filePath, index) => {
      const parsed = path.parse(filePath);
      let archiveName = parsed.base;

      if (usedNames.has(archiveName.toLowerCase())) {
        archiveName = `${String(index + 1).padStart(3, "0")}-${parsed.base}`;
      }

      while (usedNames.has(archiveName.toLowerCase())) {
        archiveName = `${String(index + 1).padStart(3, "0")}-${archiveName}`;
      }

      usedNames.add(archiveName.toLowerCase());
      return { filePath, archiveName };
    });
}

function createZipArchive(files, destinationZip) {
  return new Promise((resolve, reject) => {
    const archiveEntries = buildArchiveEntries(files);
    if (archiveEntries.length === 0) {
      resolve(null);
      return;
    }

    fs.mkdirSync(path.dirname(destinationZip), { recursive: true });

    const zip = new JSZip();
    archiveEntries.forEach(({ filePath, archiveName }) => {
      zip.file(archiveName, fs.createReadStream(filePath), {
        binary: true,
        createFolders: false
      });
    });

    const output = fs.createWriteStream(destinationZip);
    const zipStream = zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      compression: "STORE"
    });

    let settled = false;
    const finalize = (error) => {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        try {
          output.destroy();
        } catch (_destroyError) {
          // no-op
        }
        reject(error);
        return;
      }

      resolve(destinationZip);
    };

    output.on("close", () => finalize());
    output.on("error", (error) => finalize(error));
    zipStream.on("error", (error) => finalize(error));
    zipStream.pipe(output);
  });
}

function buildOptimizedGifDraft(filePath, qualityPercent) {
  return new Promise((resolve, reject) => {
    const factor = Math.max(0.1, Math.min(1, qualityPercent / 100));
    const colorCount = Math.max(16, Math.min(256, Math.round(256 * factor)));
    const scaleValue =
      factor >= 0.999 ? "iw:-1:flags=lanczos" : `trunc(iw*${factor}/2)*2:-1:flags=lanczos`;
    const filter = `scale=${scaleValue},split[a][b];[a]palettegen=max_colors=${colorCount}:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`;
    const tempOutput = path.join(
      os.tmpdir(),
      `bulk-gif-opt-${crypto.randomUUID()}${path.extname(filePath)}`
    );
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vf",
      filter,
      tempOutput
    ];
    const child = spawn(getFfmpegExecutablePath(), args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(tempOutput)) {
        if (fs.existsSync(tempOutput)) {
          fs.rmSync(tempOutput, { force: true });
        }
        reject(new Error(stderr || `Optimization failed. Code: ${code}`));
        return;
      }

      const probe = spawn(
        getFfmpegExecutablePath(),
        ["-hide_banner", "-loglevel", "error", "-i", tempOutput, "-f", "null", "-"],
        { windowsHide: true }
      );
      let probeError = "";

      probe.stderr.on("data", (chunk) => {
        probeError += chunk.toString();
      });

      probe.on("close", (probeCode) => {
        if (probeCode !== 0) {
          fs.rmSync(tempOutput, { force: true });
          reject(new Error(probeError || "Optimized GIF validation failed."));
          return;
        }

        resolve({
          filePath,
          tempPath: tempOutput,
          fileName: path.basename(filePath),
          sizeBytes: fs.statSync(tempOutput).size
        });
      });

      probe.on("error", (error) => {
        fs.rmSync(tempOutput, { force: true });
        reject(error);
      });
    });

    child.on("error", (error) => {
      if (fs.existsSync(tempOutput)) {
        fs.rmSync(tempOutput, { force: true });
      }
      reject(error);
    });
  });
}

async function stageOptimizeGifFiles(filePaths = [], qualityPercent = 80) {
  const results = [];

  for (const filePath of filePaths) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }

    results.push(await buildOptimizedGifDraft(filePath, qualityPercent));
  }

  return results;
}

function cleanupOptimizationDrafts(drafts = []) {
  for (const draft of drafts) {
    if (draft?.tempPath && fs.existsSync(draft.tempPath)) {
      fs.rmSync(draft.tempPath, { force: true });
    }
  }
}

function commitOptimizationDrafts(drafts = []) {
  const results = [];

  for (const draft of drafts) {
    if (!draft?.filePath || !draft?.tempPath || !fs.existsSync(draft.tempPath)) {
      continue;
    }

    fs.copyFileSync(draft.tempPath, draft.filePath);
    results.push({
      filePath: draft.filePath,
      fileName: path.basename(draft.filePath),
      sizeBytes: fs.statSync(draft.filePath).size
    });
  }

  cleanupOptimizationDrafts(drafts);
  return results;
}

function safeOutputPath(sourcePath, outputDir, overwriteExisting) {
  const parsed = path.parse(sourcePath);
  const baseOutput = path.join(outputDir, `${parsed.name}.gif`);

  if (overwriteExisting || !fs.existsSync(baseOutput)) {
    return baseOutput;
  }

  let attempt = 1;
  while (true) {
    const candidate = path.join(outputDir, `${parsed.name}-${attempt}.gif`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

function timeToSeconds(timeText) {
  if (!timeText) {
    return 0;
  }

  const [hours, minutes, seconds] = timeText.split(":");
  return (
    Number.parseFloat(hours || "0") * 3600 +
    Number.parseFloat(minutes || "0") * 60 +
    Number.parseFloat(seconds || "0")
  );
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-i", filePath];
    const child = spawn(getFfmpegExecutablePath(), args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", () => {
      const match = stderr.match(/Duration:\s(\d{2}:\d{2}:\d{2}\.\d{2})/);
      resolve(match ? timeToSeconds(match[1]) : 0);
    });

    child.on("error", () => resolve(0));
  });
}

function buildFilters(settings) {
  const customWidth = Number.parseInt(settings.width, 10) || 480;
  const customHeight = Number.parseInt(settings.height, 10) || 480;
  const longEdge = Number.parseInt(settings.width, 10) || 480;
  const scaleValue =
    settings.scaleMode === "original"
      ? `if(gte(iw\\,ih)\\,${longEdge}\\,-2):if(gte(ih\\,iw)\\,${longEdge}\\,-2):flags=lanczos`
      : `${customWidth}:${customHeight}:flags=lanczos`;
  const renderProfile = settings.renderProfile || "clean";
  const experimental = settings.experimental || {};
  let dither = "sierra2_4a";
  let statsMode = "diff";
  let effectiveColors = settings.colors;
  const preFilters = [`fps=${settings.fps}`, `scale=${scaleValue}`];
  const paletteUseParts = [];
  const bayerMatrixMap = {
    "2x2": 1,
    "4x4": 3,
    "8x8": 5
  };

  if (renderProfile === "detail") {
    dither = "floyd_steinberg";
  } else if (renderProfile === "retro") {
    dither = "bayer";
    statsMode = "full";
    paletteUseParts.push("bayer_scale=3");
  } else if (renderProfile === "stable") {
    dither = "bayer";
    statsMode = "single";
    paletteUseParts.push("bayer_scale=1");
    paletteUseParts.push("diff_mode=rectangle");
  } else if (renderProfile === "experimental") {
    dither = experimental.dither || "sierra2_4a";
    statsMode = experimental.statsMode || "diff";
    effectiveColors = Math.max(
      16,
      Math.min(
        256,
        settings.colors -
          Math.round((Number(experimental.ditherStrength) || 0) * 0.45) -
          (Number(experimental.posterize) || 0) * 6
      )
    );

    if (experimental.adaptive) {
      dither =
        (Number(experimental.flatProtect) || 0) > 55
          ? "bayer"
          : (Number(experimental.edgeBias) || 0) > 55
            ? "floyd_steinberg"
            : "sierra2_4a";
    }

    if ((Number(experimental.noiseProtect) || 0) > 0) {
      const amount = (Number(experimental.noiseProtect) / 100) * 1.2;
      preFilters.push(`hqdn3d=${amount.toFixed(2)}:${amount.toFixed(2)}:6:6`);
    }

    if ((Number(experimental.edgeBias) || 0) > 0) {
      const amount = ((Number(experimental.edgeBias) || 0) / 100) * 1.4;
      preFilters.push(`unsharp=5:5:${amount.toFixed(2)}:3:3:0`);
    }

    if (experimental.retroCrt) {
      dither = "bayer";
      preFilters.push("eq=contrast=1.08:saturation=0.88:brightness=-0.02");
    }

    if (experimental.temporalStable) {
      statsMode = "single";
      paletteUseParts.push("diff_mode=rectangle");
    } else if (experimental.diffMode && experimental.diffMode !== "none") {
      paletteUseParts.push(`diff_mode=${experimental.diffMode}`);
    }

    if (dither === "bayer") {
      const baseScale = bayerMatrixMap[experimental.bayerMatrix] ?? 3;
      const strengthOffset = Math.round((50 - (Number(experimental.ditherStrength) || 50)) / 25);
      const bayerScale = Math.max(0, Math.min(5, baseScale + strengthOffset));
      paletteUseParts.push(`bayer_scale=${bayerScale}`);
    }

    if ((Number(experimental.flatProtect) || 0) > 55 && statsMode === "diff") {
      statsMode = "single";
    }
  }

  const paletteUse = [`dither=${dither}`].concat(paletteUseParts).join(":");
  const filterPrefix = preFilters.join(",");
  return `${filterPrefix},split[a][b];[a]palettegen=max_colors=${effectiveColors}:stats_mode=${statsMode}[p];[b][p]paletteuse=${paletteUse}`;
}

function buildFfmpegArgs(inputPath, outputPath, settings) {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "info",
    "-i",
    inputPath,
    "-vf",
    buildFilters(settings),
    outputPath
  ];
}

function convertSingleVideo(job, settings) {
  return new Promise(async (resolve) => {
    const effectiveSettings = {
      ...settings,
      ...(job.renderSettings || {})
    };
    fs.mkdirSync(effectiveSettings.outputDir, { recursive: true });
    const duration = await probeDuration(job.inputPath);
    const outputPath = safeOutputPath(
      job.inputPath,
      effectiveSettings.outputDir,
      effectiveSettings.overwriteExisting
    );
    const args = buildFfmpegArgs(job.inputPath, outputPath, {
      ...effectiveSettings,
      fps: job.fps || effectiveSettings.fps || 12
    });
    const child = spawn(getFfmpegExecutablePath(), args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const cancelChannel = `cancel-conversion-${job.id}`;
    let cancelListener = () => {};

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      ipcMain.removeListener(cancelChannel, cancelListener);
      resolve(result);
    };

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (!match) {
        return;
      }

      const current = timeToSeconds(match[1]);
      const ratio = duration > 0 ? Math.min(current / duration, 1) : 0;

      mainWindow.webContents.send("conversion-progress", {
        id: job.id,
        progress: ratio,
        outputPath
      });
    });

    child.on("close", (code) => {
      if (cancelRequested) {
        finish({
          status: "cancelled",
          outputPath
        });
        return;
      }

      if (code === 0) {
        finish({
          status: "done",
          outputPath
        });
        return;
      }

      finish({
        status: "error",
        outputPath,
        error: stderr || `ffmpeg exit code ${code}`
      });
    });

    child.on("error", (error) => {
      finish({
        status: "error",
        outputPath,
        error: error.message
      });
    });

    cancelListener = () => {
      if (child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch (_error) {
            // Ignore best-effort cancellation failures.
          }
        });
      } else {
        try {
          child.kill();
        } catch (_error) {
          // Ignore best-effort cancellation failures.
        }
      }
      finish({
        status: "cancelled",
        outputPath
      });
    };

    ipcMain.once(cancelChannel, cancelListener);
  });
}

ipcMain.handle("pick-video-files", async () => selectVideoFiles());
ipcMain.handle("pick-video-folder", async () => selectVideoFolder());
ipcMain.handle("pick-output-folder", async () => selectOutputFolder());
ipcMain.handle("normalize-drop-paths", async (_event, pathsToNormalize) =>
  normalizeDropPaths(pathsToNormalize)
);
ipcMain.handle("generate-video-previews", async (_event, pathsToPreview) =>
  generateVideoPreviews(pathsToPreview)
);
ipcMain.handle("get-file-entries", async (_event, filePaths) => getFileEntries(filePaths));
ipcMain.handle("stage-optimize-gifs", async (_event, payload) =>
  stageOptimizeGifFiles(payload.files || [], payload.qualityPercent)
);
ipcMain.handle("commit-optimized-gifs", async (_event, drafts) =>
  commitOptimizationDrafts(drafts || [])
);
ipcMain.handle("discard-optimized-gifs", async (_event, drafts) => {
  cleanupOptimizationDrafts(drafts || []);
  return true;
});
ipcMain.handle("save-zip-archive", async (_event, payload) => {
  const zipPath = await pickZipDestination(payload.outputDir);
  if (!zipPath) {
    return { cancelled: true };
  }

  const createdZip = await createZipArchive(payload.files || [], zipPath);
  return {
    cancelled: false,
    zipPath: createdZip
  };
});
ipcMain.handle("save-gif-file-as", async (_event, payload) => saveGifFileAs(payload));

ipcMain.handle("open-path", async (_event, targetPath) => {
  if (!targetPath) {
    return false;
  }
  await shell.openPath(targetPath);
  return true;
});

ipcMain.handle("open-external-url", async (_event, targetUrl) => {
  if (!targetUrl) {
    return false;
  }
  await shell.openExternal(targetUrl);
  return true;
});

ipcMain.handle("cancel-batch", async (_event, jobs) => {
  cancelRequested = true;
  for (const job of jobs || []) {
    ipcMain.emit(`cancel-conversion-${job.id}`);
  }
  return true;
});

ipcMain.handle("convert-batch", async (_event, payload) => {
  cancelRequested = false;

  const jobs = payload.jobs || [];
  const settings = payload.settings;
  const results = [];

  for (let index = 0; index < jobs.length; index += 1) {
    if (cancelRequested) {
      const cancelledResult = {
        id: jobs[index].id,
        inputPath: jobs[index].inputPath,
        status: "cancelled"
      };
      results.push(cancelledResult);
      mainWindow.webContents.send("conversion-finished", cancelledResult);
      continue;
    }

    mainWindow.webContents.send("conversion-started", {
      id: jobs[index].id,
      queueIndex: index + 1,
      total: jobs.length
    });

    const result = await convertSingleVideo(jobs[index], settings);
    results.push({
      id: jobs[index].id,
      inputPath: jobs[index].inputPath,
      ...result
    });

    mainWindow.webContents.send("conversion-finished", {
      id: jobs[index].id,
      ...result
    });
  }

  cancelRequested = false;
  return results;
});

app.whenReady().then(() => {
  validateAppManifest();
  createTray();
  createWindow();

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
