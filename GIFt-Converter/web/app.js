const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "m4v",
  "wmv",
  "flv",
  "mpeg",
  "mpg",
  "3gp",
  "ts",
  "mts",
  "m2ts",
  "ogv",
  "ogm",
  "qt",
  "asf",
  "vob",
  "mxf",
  "f4v",
  "rm",
  "rmvb",
  "divx"
]);

const { FFmpeg } = window.FFmpegWASM;
const JSZip = window.JSZip;
const LOCAL_CORE_URL = new URL("./vendor/core/ffmpeg-core.js", window.location.href).href;
const LOCAL_WASM_URL = new URL("./vendor/core/ffmpeg-core.wasm", window.location.href).href;
const IS_FILE_PROTOCOL = window.location.protocol === "file:";
const FILE_PROTOCOL_MESSAGE =
  "Open this web app through http://localhost or https://. file:// blocks the browser worker required for conversion.";

const state = {
  jobs: [],
  ffmpeg: null,
  ffmpegLoaded: false,
  ffmpegLoadPromise: null,
  running: false,
  cancelRequested: false,
  activeProgressJobId: null,
  canResume: false
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  pickButton: document.querySelector("#pickButton"),
  statusLine: document.querySelector("#statusLine"),
  bulkFpsInput: document.querySelector("#bulkFpsInput"),
  applyAllFpsButton: document.querySelector("#applyAllFpsButton"),
  applySelectedFpsButton: document.querySelector("#applySelectedFpsButton"),
  renderModeSelect: document.querySelector("#renderModeSelect"),
  colorCountInput: document.querySelector("#colorCountInput"),
  sizeModeSelect: document.querySelector("#sizeModeSelect"),
  widthInput: document.querySelector("#widthInput"),
  heightInput: document.querySelector("#heightInput"),
  heightField: document.querySelector("#heightField"),
  primarySizeLabel: document.querySelector("#primarySizeLabel"),
  secondarySizeLabel: document.querySelector("#secondarySizeLabel"),
  exportButton: document.querySelector("#exportButton"),
  zipButton: document.querySelector("#zipButton"),
  selectAllButton: document.querySelector("#selectAllButton"),
  clearButton: document.querySelector("#clearButton"),
  progressCounter: document.querySelector("#progressCounter"),
  jobsMeter: document.querySelector("#jobsMeter"),
  jobsMeterLabel: document.querySelector("#jobsMeterLabel"),
  topResumeButton: document.querySelector("#topResumeButton"),
  topStopButton: document.querySelector("#topStopButton"),
  queueBody: document.querySelector("#queueBody"),
  dropZone: document.querySelector("#dropZone"),
  logPanel: document.querySelector("#logPanel")
};

function getExtension(name = "") {
  const match = String(name).toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

function isSupportedVideoFile(file) {
  if (!file) {
    return false;
  }

  const extension = getExtension(file.name);
  if (VIDEO_EXTENSIONS.has(extension)) {
    return true;
  }

  return String(file.type || "").startsWith("video/");
}

function fetchFile(file) {
  return new Promise((resolve, reject) => {
    if (file instanceof File || file instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => {
        const { result } = reader;
        resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array());
      };
      reader.onerror = (event) => {
        reject(
          Error(`File could not be read! Code=${event?.target?.error?.code || -1}`)
        );
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    if (typeof file === "string") {
      fetch(file)
        .then((response) => response.arrayBuffer())
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(reject);
      return;
    }

    resolve(new Uint8Array());
  });
}

function addLog(message, tone = "default") {
  const item = document.createElement("div");
  item.className = `log-entry${tone === "default" ? "" : ` log-entry-${tone}`}`;
  const timestamp = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  item.innerHTML = `<div>${message}</div><div class="log-time">${timestamp}</div>`;
  elements.logPanel.prepend(item);
}

function isFileProtocolError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return IS_FILE_PROTOCOL && (text.includes("failed to construct 'worker'") || text.includes("origin 'null'"));
}

function setStatus(text, tone = "ready") {
  elements.statusLine.textContent = text;
  elements.statusLine.style.color =
    tone === "error" ? "#a62e2e" : tone === "warn" ? "#8a6300" : "#387a49";
}

function getDefaultFps() {
  return Math.max(1, Math.min(60, Number(elements.bulkFpsInput.value) || 15));
}

function hasResumableJobs() {
  return state.jobs.some((job) => !job.gifBlob);
}

function setRunning(isRunning) {
  state.running = isRunning;
  elements.exportButton.disabled = isRunning;
  elements.zipButton.disabled = isRunning || state.jobs.filter((job) => job.gifBlob).length === 0;
  if (elements.topResumeButton) {
    elements.topResumeButton.disabled = isRunning || !state.canResume;
  }
  if (elements.topStopButton) {
    elements.topStopButton.disabled = !isRunning;
  }
}

function updateProtocolModeUi() {
  if (!IS_FILE_PROTOCOL) {
    return;
  }

  elements.exportButton.disabled = true;
  elements.zipButton.disabled = true;
  if (elements.topResumeButton) {
    elements.topResumeButton.disabled = true;
  }
  if (elements.topStopButton) {
    elements.topStopButton.disabled = true;
  }
}

function updateSizeModeUi() {
  const custom = elements.sizeModeSelect.value === "custom";
  elements.primarySizeLabel.textContent = custom ? "Width (px)" : "Long edge (px)";
  elements.secondarySizeLabel.textContent = custom ? "Height (px)" : "Height (auto)";
  elements.heightInput.disabled = !custom;
  elements.heightField.classList.toggle("field-disabled", !custom);
}

function createJob(file) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    file,
    selected: true,
    fps: getDefaultFps(),
    status: "Waiting",
    progress: 0,
    gifBlob: null,
    gifName: file.name.replace(/\.[^.]+$/, "") + ".gif",
    previewUrl: URL.createObjectURL(file)
  };
}

function removeQueuedJob(jobId) {
  const targetIndex = state.jobs.findIndex((job) => job.id === jobId);
  if (targetIndex === -1) {
    return;
  }

  const targetJob = state.jobs[targetIndex];
  if (state.running && targetJob.status === "Converting") {
    stopExport();
    return;
  }

  if (state.running) {
    return;
  }

  URL.revokeObjectURL(targetJob.previewUrl);
  state.jobs.splice(targetIndex, 1);
  renderQueue();
  setStatus("Video removed from the queue.", "ready");
}

function updateSummary() {
  const total = state.jobs.length;
  const readyJobs = state.jobs.filter((job) => job.gifBlob);
  const completed = readyJobs.length;
  elements.progressCounter.textContent = `${completed} / ${total} completed`;
  elements.jobsMeterLabel.textContent = `${total} jobs`;
  const progress = total === 0 ? 0 : (completed / total) * 100;
  elements.jobsMeter.style.setProperty("--completion-progress", `${progress}%`);
  elements.jobsMeter.classList.toggle("is-running", state.running && completed < total);
  elements.zipButton.textContent = completed === 1 ? "Download GIF" : "Download ZIP";
  elements.zipButton.disabled = completed === 0 || state.running;
  state.canResume = hasResumableJobs();
  if (elements.topResumeButton) {
    elements.topResumeButton.disabled = state.running || !state.canResume;
  }
  if (elements.topStopButton) {
    elements.topStopButton.disabled = !state.running;
  }
}

function renderQueue() {
  if (state.jobs.length === 0) {
    elements.queueBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">Drop videos here or use Start Import.</td>
      </tr>
    `;
    updateSummary();
    return;
  }

  elements.queueBody.innerHTML = state.jobs
    .map((job) => {
      const progressPercent =
        job.status === "Completed"
          ? 100
          : Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
      const output = job.gifBlob
        ? `<a class="output-link" href="${URL.createObjectURL(job.gifBlob)}" download="${job.gifName}">Download GIF</a>`
        : "Not ready";
      const rowAction =
        state.running
          ? job.status === "Converting"
            ? `<button class="row-remove-button" type="button" data-remove-row="${job.id}" aria-label="Abort">x</button>`
            : ""
          : `<button class="row-remove-button" type="button" data-remove-row="${job.id}" aria-label="Remove">x</button>`;
      const statusClasses = [
        "status-pill",
        job.status === "Waiting" && state.running ? "is-pending" : "",
        job.status === "Converting" ? "is-active" : "",
        job.status === "Completed" ? "is-complete" : "",
        job.status === "Error" || job.status === "Cancelled" ? "is-error" : ""
      ]
        .filter(Boolean)
        .join(" ");
      return `
        <tr class="${job.status === "Completed" ? "row-done" : ""}">
          <td><input type="checkbox" data-select="${job.id}" ${job.selected ? "checked" : ""} /></td>
          <td>
            <div class="file-cell">
              <video class="preview" src="${job.previewUrl}" muted playsinline loop autoplay></video>
              <div>
                <div class="file-name">${job.file.name}</div>
                <div class="file-sub">${job.file.name}</div>
              </div>
            </div>
          </td>
          <td><input class="row-fps-input" type="number" min="1" max="60" value="${job.fps}" data-fps="${job.id}" /></td>
          <td><span class="${statusClasses}">${job.status}</span></td>
          <td>
            <div class="progress-wrap">
              <div class="progress-bar ${job.status === "Completed" ? "is-complete" : ""}"><span style="width:${progressPercent}%"></span></div>
              <div class="progress-copy ${job.status === "Completed" ? "is-complete" : ""}">${progressPercent}%</div>
            </div>
          </td>
          <td>
            <div class="output-cell">
              <div class="output-copy">${output}</div>
              ${rowAction}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  updateSummary();
}

function getRenderSettings() {
  const mode = elements.renderModeSelect.value;
  const colors = Number(elements.colorCountInput.value) || 96;
  if (mode === "detail") {
    return { dither: "floyd_steinberg", colors: Math.max(96, colors), stats: "full" };
  }
  if (mode === "retro") {
    return { dither: "bayer", colors: Math.min(96, colors), stats: "single", bayerScale: 3 };
  }
  if (mode === "stable") {
    return { dither: "sierra2_4a", colors, stats: "single" };
  }
  return { dither: "sierra2_4a", colors, stats: "diff" };
}

function getScaleFilter() {
  const sizeMode = elements.sizeModeSelect.value;
  const width = Math.max(64, Number(elements.widthInput.value) || 640);
  const height = Math.max(64, Number(elements.heightInput.value) || 480);
  if (sizeMode === "custom") {
    return `scale=${width}:${height}:flags=lanczos`;
  }
  return `scale='if(gt(iw,ih),${width},-1)':'if(gt(iw,ih),-1,${width})':flags=lanczos`;
}

async function ensureFfmpeg() {
  if (IS_FILE_PROTOCOL) {
    throw new Error(FILE_PROTOCOL_MESSAGE);
  }

  if (state.ffmpegLoaded) {
    return state.ffmpeg;
  }

  if (state.ffmpegLoadPromise) {
    return state.ffmpegLoadPromise;
  }

  setStatus("Loading browser engine...", "warn");
  addLog("Loading browser engine...");
  state.ffmpegLoadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: LOCAL_CORE_URL,
      wasmURL: LOCAL_WASM_URL
    });
    ffmpeg.on("progress", ({ progress }) => {
      const job = state.jobs.find((item) => item.id === state.activeProgressJobId);
      if (!job || job.status === "Completed" || job.status === "Cancelled" || job.status === "Error") {
        return;
      }

      const nextProgress = Math.max(6, Math.min(98, progress * 100));
      job.progress = Math.max(Number(job.progress) || 0, nextProgress);
      renderQueue();
    });
    state.ffmpeg = ffmpeg;
    state.ffmpegLoaded = true;
    addLog("Browser engine is ready.", "success");
    return ffmpeg;
  })();

  try {
    return await state.ffmpegLoadPromise;
  } finally {
    if (!state.ffmpegLoaded) {
      state.ffmpegLoadPromise = null;
    }
  }
}

async function resetFfmpeg() {
  if (state.ffmpeg && typeof state.ffmpeg.terminate === "function") {
    try {
      await state.ffmpeg.terminate();
    } catch (_error) {
      // no-op
    }
  }

  state.ffmpeg = null;
  state.ffmpegLoaded = false;
  state.ffmpegLoadPromise = null;
}

function warmBrowserEngine() {
  if (IS_FILE_PROTOCOL) {
    return;
  }

  if (state.ffmpegLoaded || state.ffmpegLoadPromise) {
    return;
  }

  ensureFfmpeg().catch((error) => {
    console.error(error);
    addLog(`Browser engine preload failed: ${error.message}`, "error");
    if (!state.running) {
      setStatus("Browser engine failed to preload.", "warn");
    }
  });
}

async function convertJob(job, index, total) {
  const ffmpeg = await ensureFfmpeg();
  const inputName = `${job.id}-${job.file.name}`;
  const outputName = `${job.id}.gif`;
  const paletteName = `${job.id}.png`;
  const fps = Math.max(1, Math.min(60, Number(job.fps) || 15));
  const render = getRenderSettings();
  const scale = getScaleFilter();

  addLog(`GIF generation started for ${job.file.name}. FPS: ${fps}`);
  job.status = "Converting";
  job.progress = 6;
  state.activeProgressJobId = job.id;
  renderQueue();

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(job.file));
    await ffmpeg.exec([
      "-i",
      inputName,
      "-vf",
      `fps=${fps},${scale},palettegen=max_colors=${render.colors}:stats_mode=${render.stats}`,
      paletteName
    ]);

    const paletteUse =
      render.dither === "bayer"
        ? `paletteuse=dither=bayer:bayer_scale=${render.bayerScale || 3}`
        : `paletteuse=dither=${render.dither}`;

    await ffmpeg.exec([
      "-i",
      inputName,
      "-i",
      paletteName,
      "-lavfi",
      `fps=${fps},${scale}[x];[x][1:v]${paletteUse}`,
      "-loop",
      "0",
      outputName
    ]);

    const data = await ffmpeg.readFile(outputName);
    job.gifBlob = new Blob([data.buffer], { type: "image/gif" });
    job.status = "Completed";
    job.progress = 100;
    addLog(`${job.file.name} was converted to GIF successfully.`, "success");
    setStatus(`Converted ${index + 1}/${total}.`, "ready");
  } catch (error) {
    if (state.cancelRequested) {
      job.status = "Cancelled";
      job.progress = 0;
      addLog(`${job.file.name} was cancelled.`, "error");
      return;
    }

    job.status = "Error";
    job.progress = 0;
    addLog(`Conversion error: ${error.message}`, "error");
    throw error;
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
    } catch (_error) {
      // no-op
    }
    try {
      await ffmpeg.deleteFile(paletteName);
    } catch (_error) {
      // no-op
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch (_error) {
      // no-op
    }
    if (state.activeProgressJobId === job.id) {
      state.activeProgressJobId = null;
    }
    renderQueue();
  }
}

async function exportAll(resumeMode = false) {
  if (state.running || state.jobs.length === 0) {
    return;
  }

  if (IS_FILE_PROTOCOL) {
    setStatus("Local preview mode. Use http://localhost or https:// for conversion.", "warn");
    addLog(FILE_PROTOCOL_MESSAGE, "error");
    return;
  }

  try {
    const jobs = state.jobs.filter((job) => job.selected && (!resumeMode || !job.gifBlob));
    if (jobs.length === 0) {
      setStatus(resumeMode ? "No remaining videos to continue." : "Select videos first.", "warn");
      addLog(resumeMode ? "No remaining videos to continue." : "Select videos first.", "error");
      return;
    }

    state.cancelRequested = false;
    state.canResume = false;
    for (const job of state.jobs) {
      if (!job.selected) {
        continue;
      }
      if (resumeMode && job.gifBlob) {
        continue;
      }
      job.status = "Waiting";
      job.progress = 0;
      if (!resumeMode) {
        job.gifBlob = null;
      }
    }
    setRunning(true);
    renderQueue();
    setStatus(resumeMode ? "Continuing queue..." : "Preparing export...", "warn");

    for (let index = 0; index < jobs.length; index += 1) {
      await convertJob(jobs[index], index, jobs.length);
      if (state.cancelRequested) {
        break;
      }
    }
    if (state.cancelRequested) {
      setStatus("Export stopped.", "warn");
      addLog("Export was stopped by the user.", "error");
    } else {
      setStatus("GIFs are ready.", "ready");
    }
    const successCount = state.jobs.filter((job) => job.gifBlob).length;
    const errorCount = state.jobs.filter((job) => job.status === "Error").length;
    const cancelledCount = state.jobs.filter((job) => job.status === "Cancelled").length;
    addLog(
      `Export finished. Success: ${successCount}, errors: ${errorCount}, cancelled: ${cancelledCount}.`,
      errorCount > 0 || cancelledCount > 0 ? "error" : "success"
    );
  } catch (error) {
    console.error(error);
    if (isFileProtocolError(error)) {
      setStatus("Use http://localhost or https:// for conversion.", "warn");
      addLog(FILE_PROTOCOL_MESSAGE, "error");
    } else {
      setStatus("Browser conversion failed.", "error");
      addLog(`Conversion error: ${error.message}`, "error");
    }
  } finally {
    state.canResume = hasResumableJobs();
    setRunning(false);
    state.cancelRequested = false;
    updateSummary();
  }
}

function downloadGifBlob(job) {
  const url = URL.createObjectURL(job.gifBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = job.gifName;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("GIF downloaded.", "ready");
  addLog("GIF download is ready.", "success");
}

async function downloadOutputs() {
  const ready = state.jobs.filter((job) => job.gifBlob);
  if (ready.length === 0) {
    setStatus("No GIFs are ready for ZIP.", "warn");
    addLog("No GIFs are ready for ZIP.", "error");
    return;
  }

  if (ready.length === 1) {
    downloadGifBlob(ready[0]);
    return;
  }

  const zip = new JSZip();
  ready.forEach((job) => zip.file(job.gifName, job.gifBlob));
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "gift-converter-export.zip";
  link.click();
  URL.revokeObjectURL(url);
  setStatus("ZIP downloaded.", "ready");
  addLog("ZIP download is ready.", "success");
}

async function stopExport() {
  if (!state.running) {
    return;
  }

  state.cancelRequested = true;
  setStatus("Stopping export...", "warn");
  addLog("Stop requested.", "error");
  await resetFfmpeg();
}

async function continueExport() {
  return exportAll(true);
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  const fresh = files.filter((file) => isSupportedVideoFile(file));
  const fallback = fresh.length === 0 ? files.filter(Boolean) : [];
  const accepted = fresh.length > 0 ? fresh : fallback;
  if (accepted.length === 0) {
    setStatus("No supported videos found.", "warn");
    addLog("No supported videos found.", "error");
    return;
  }
  state.jobs.push(...accepted.map(createJob));
  renderQueue();
  setStatus(`${accepted.length} videos added.`, "ready");
  warmBrowserEngine();
  if (fresh.length === 0 && fallback.length > 0) {
    addLog(`Accepted ${accepted.length} selected files with fallback detection.`, "success");
  } else {
    addLog(`${accepted.length} videos added.`, "success");
  }
}

elements.fileInput.addEventListener("change", (event) => {
  addFiles(event.target.files);
  event.target.value = "";
});
elements.applyAllFpsButton.addEventListener("click", () => {
  const fps = getDefaultFps();
  state.jobs.forEach((job) => {
    job.fps = fps;
  });
  renderQueue();
  addLog(`Applied FPS ${fps} to all videos.`);
});
elements.applySelectedFpsButton.addEventListener("click", () => {
  const fps = getDefaultFps();
  const selected = state.jobs.filter((job) => job.selected);
  if (selected.length === 0) {
    setStatus("Select videos first.", "warn");
    addLog("Select videos first.", "error");
    return;
  }
  selected.forEach((job) => {
    job.fps = fps;
  });
  renderQueue();
  addLog(`Applied FPS ${fps} to ${selected.length} selected videos.`);
});
elements.sizeModeSelect.addEventListener("change", updateSizeModeUi);
elements.exportButton.addEventListener("click", () => exportAll(false));
elements.zipButton.addEventListener("click", downloadOutputs);
if (elements.topResumeButton) {
  elements.topResumeButton.addEventListener("click", continueExport);
}
if (elements.topStopButton) {
  elements.topStopButton.addEventListener("click", stopExport);
}
elements.selectAllButton.addEventListener("click", () => {
  const next = state.jobs.some((job) => !job.selected);
  state.jobs = state.jobs.map((job) => ({ ...job, selected: next }));
  renderQueue();
});
elements.clearButton.addEventListener("click", () => {
  if (state.running) {
    return;
  }

  const selectedIds = new Set(state.jobs.filter((job) => job.selected).map((job) => job.id));
  if (selectedIds.size === 0) {
    setStatus("Select videos first.", "warn");
    addLog("Select videos first.", "error");
    return;
  }

  state.jobs.forEach((job) => {
    if (selectedIds.has(job.id)) {
      URL.revokeObjectURL(job.previewUrl);
    }
  });
  state.jobs = state.jobs.filter((job) => !selectedIds.has(job.id));
  renderQueue();
  setStatus("Selected videos cleared.", "ready");
  addLog("Selected videos cleared.");
});
elements.queueBody.addEventListener("change", (event) => {
  const removeTarget = event.target.closest("[data-remove-row]");
  if (removeTarget) {
    removeQueuedJob(removeTarget.dataset.removeRow);
    return;
  }

  const selectTarget = event.target.closest("[data-select]");
  if (selectTarget) {
    state.jobs = state.jobs.map((job) =>
      job.id === selectTarget.dataset.select ? { ...job, selected: selectTarget.checked } : job
    );
    renderQueue();
    return;
  }

  const fpsTarget = event.target.closest("[data-fps]");
  if (fpsTarget) {
    const fps = Math.max(1, Math.min(60, Number(fpsTarget.value) || 15));
    state.jobs = state.jobs.map((job) =>
      job.id === fpsTarget.dataset.fps ? { ...job, fps } : job
    );
    renderQueue();
  }
});

elements.queueBody.addEventListener("click", (event) => {
  const removeTarget = event.target.closest("[data-remove-row]");
  if (!removeTarget) {
    return;
  }

  event.preventDefault();
  removeQueuedJob(removeTarget.dataset.removeRow);
});

["dragenter", "dragover"].forEach((type) => {
  elements.dropZone.addEventListener(type, (event) => {
    event.preventDefault();
  });
});

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  addFiles(event.dataTransfer.files);
});

updateSizeModeUi();
renderQueue();
addLog("Web app is ready.");
if (IS_FILE_PROTOCOL) {
  updateProtocolModeUi();
  addLog("Local file preview mode detected. Conversion is disabled until the app is opened through http://localhost or https://.", "error");
  setStatus("Local preview mode. Conversion disabled until http/https.", "warn");
}

if ("requestIdleCallback" in window) {
  window.requestIdleCallback(() => warmBrowserEngine(), { timeout: 1200 });
} else {
  window.setTimeout(() => warmBrowserEngine(), 700);
}
