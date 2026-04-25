const pickFileBtn = document.getElementById("pickFileBtn");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const fileNameEl = document.getElementById("fileName");
const processBtn = document.getElementById("processBtn");
const statusEl = document.getElementById("status");
const originalPanel = document.getElementById("originalPanel");
const resultPanel = document.getElementById("resultPanel");
const originalAudio = document.getElementById("originalAudio");
const resultAudio = document.getElementById("resultAudio");
const originalWave = document.getElementById("originalWave");
const resultWave = document.getElementById("resultWave");
const ratioValue = document.getElementById("ratioValue");
const downloadProcessedBtn = document.getElementById("downloadProcessedBtn");

let uploadedId = "";
let selectedFile = null;
let processedDownloadUrl = "";

pickFileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", onFileSelected);
processBtn.addEventListener("click", onProcessClick);
downloadProcessedBtn.addEventListener("click", onDownloadClick);
window.addEventListener("resize", () => {
  if (originalAudio.src) {
    drawWaveformFromSource(originalAudio.src, originalWave).catch(() => {});
  }
  if (resultAudio.src) {
    drawWaveformFromSource(resultAudio.src, resultWave).catch(() => {});
  }
});

async function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  selectedFile = file;
  uploadedId = "";
  processedDownloadUrl = "";
  resultPanel.classList.add("hidden");
  downloadProcessedBtn.classList.add("hidden");
  ratioValue.textContent = "-";

  fileInfo.classList.remove("hidden");
  originalPanel.classList.remove("hidden");
  processBtn.classList.remove("hidden");
  processBtn.disabled = true;

  fileNameEl.textContent = file.name;
  statusEl.textContent = "Загрузка файла на сервер...";

  const localUrl = URL.createObjectURL(file);
  originalAudio.src = localUrl;
  await drawWaveformFromSource(localUrl, originalWave);

  try {
    const formData = new FormData();
    formData.append("file", file, file.name);

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    uploadedId = payload.id;
    processBtn.disabled = false;
    statusEl.textContent = "Файл загружен. Нажмите «Очистить от тишины».";
  } catch (error) {
    statusEl.textContent = `Ошибка загрузки: ${error.message}`;
  }
}

async function onProcessClick() {
  if (!uploadedId) {
    statusEl.textContent = "Сначала дождитесь окончания загрузки.";
    return;
  }

  processBtn.disabled = true;
  statusEl.textContent = "Идет обработка...";

  try {
    const response = await fetch(`/api/process/${uploadedId}`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    const processedUrl = `${payload.processedUrl}?t=${Date.now()}`;
    resultAudio.src = processedUrl;
    resultPanel.classList.remove("hidden");
    processedDownloadUrl = payload.processedUrl;
    downloadProcessedBtn.classList.remove("hidden");
    try {
      await drawWaveformFromSource(processedUrl, resultWave);
    } catch (_) {
      // Waveform rendering failure should not block playback/download UX.
    }

    const originalDurationSec = Number(payload.originalDurationSec || 0);
    const processedDurationSec = Number(payload.processedDurationSec || 0);
    const originalDisplaySec = Math.max(1, Math.round(originalDurationSec));
    const processedDisplaySec = Math.max(1, Math.round(processedDurationSec));
    const ratio = processedDisplaySec > 0 ? originalDisplaySec / processedDisplaySec : 0;
    if (ratio > 0) {
      const savedPercent = (1 - processedDisplaySec / originalDisplaySec) * 100;
      ratioValue.textContent = `${ratio.toFixed(1)}x (${savedPercent.toFixed(1)}%)`;
    } else {
      ratioValue.textContent = "-";
    }

    statusEl.textContent = "Готово. Можно сравнить исходник и итог.";
  } catch (error) {
    statusEl.textContent = `Ошибка обработки: ${error.message}`;
  } finally {
    processBtn.disabled = false;
  }
}

function buildProcessedFileName(originalName) {
  const dotIndex = originalName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${originalName || "audio"}_processed.wav`;
  }
  const base = originalName.slice(0, dotIndex);
  return `${base}_processed.wav`;
}

async function onDownloadClick() {
  if (!processedDownloadUrl) {
    return;
  }

  try {
    const response = await fetch(processedDownloadUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(await response.text());
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = buildProcessedFileName(selectedFile?.name || "processed.wav");
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    statusEl.textContent = `Ошибка скачивания: ${error.message}`;
  }
}

async function drawWaveformFromSource(source, canvas) {
  resizeCanvas(canvas);
  const data = await loadAudioData(source);
  const peaks = extractPeaks(data, canvas.width);
  renderWaveform(canvas, peaks);
}

function resizeCanvas(canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(320, Math.floor(canvas.getBoundingClientRect().width));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(96 * dpr);
}

async function loadAudioData(source) {
  let arrayBuffer;
  if (source instanceof File) {
    arrayBuffer = await source.arrayBuffer();
  } else {
    const response = await fetch(source);
    arrayBuffer = await response.arrayBuffer();
  }

  const audioContext = new AudioContext();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const channelData = decoded.getChannelData(0);
  await audioContext.close();
  return channelData;
}

function extractPeaks(channelData, width) {
  const blockSize = Math.max(1, Math.floor(channelData.length / width));
  const peaks = [];

  for (let i = 0; i < width; i++) {
    const start = i * blockSize;
    const end = Math.min(channelData.length, start + blockSize);
    let min = 1;
    let max = -1;
    for (let j = start; j < end; j++) {
      const value = channelData[j];
      if (value > max) max = value;
      if (value < min) min = value;
    }
    peaks.push([min, max]);
  }

  return peaks;
}

function renderWaveform(canvas, peaks) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const mid = height / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fcf8ee";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#2d6a4f";
  ctx.lineWidth = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  ctx.beginPath();

  for (let i = 0; i < peaks.length; i++) {
    const [min, max] = peaks[i];
    ctx.moveTo(i, mid + min * mid);
    ctx.lineTo(i, mid + max * mid);
  }

  ctx.stroke();
}
