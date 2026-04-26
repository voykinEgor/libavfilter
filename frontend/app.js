const pickFileBtn = document.getElementById("pickFileBtn");
const recordBtn = document.getElementById("recordBtn");
const recordTimerEl = document.getElementById("recordTimer");
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

const APP_STATES = Object.freeze({
  IDLE: "idle",
  REQUESTING_PERMISSION: "requestingPermission",
  RECORDING: "recording",
  RECORDED: "recorded",
  PROCESSING: "processing",
  PROCESSED: "processed",
});

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

let appState = APP_STATES.IDLE;
let uploadedId = "";
let selectedFile = null;
let processedDownloadUrl = "";
let originalObjectUrl = "";

let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let recordTimerId = null;
let recordingStartedAt = 0;

pickFileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", onFileSelected);
recordBtn.addEventListener("click", onRecordClick);
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

setRecordButtonState("idle");
setAppState(APP_STATES.IDLE, "Готово к загрузке или записи.");

if (!isRecordingSupported()) {
  recordBtn.disabled = true;
  recordBtn.title = "Ваш браузер не поддерживает MediaRecorder/getUserMedia";
  setAppState(APP_STATES.IDLE, "Запись в этом браузере не поддерживается. Можно загрузить готовый аудиофайл.");
}

async function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  fileInput.value = "";
  await loadInputFile(file, "Файл выбран.");
}

async function onRecordClick() {
  if (appState === APP_STATES.RECORDING) {
    stopRecording();
    return;
  }

  await startRecording();
}

async function startRecording() {
  if (!isRecordingSupported()) {
    setAppState(resolveFallbackState(), "Запись не поддерживается в этом браузере.");
    return;
  }

  setRecordButtonState("requesting");
  resetRecordingTimer();
  setAppState(APP_STATES.REQUESTING_PERMISSION, "Запрашиваем доступ к микрофону...");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const options = pickRecorderOptions();
    mediaRecorder = options ? new MediaRecorder(mediaStream, options) : new MediaRecorder(mediaStream);
    recordedChunks = [];

    mediaRecorder.addEventListener("dataavailable", onRecorderDataAvailable);
    mediaRecorder.addEventListener("stop", onRecorderStop);
    mediaRecorder.addEventListener("error", onRecorderError);

    mediaRecorder.start(200);
    setRecordButtonState("recording");
    startRecordingTimer();
    setAppState(APP_STATES.RECORDING, "Идет запись. Нажмите кнопку еще раз, чтобы остановить.");
  } catch (error) {
    cleanupRecorderResources();
    resetRecordingTimer();
    setRecordButtonState("idle");
    setAppState(resolveFallbackState(), mapRecordingStartError(error));
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  setRecordButtonState("stopping");
  mediaRecorder.stop();
}

function onRecorderDataAvailable(event) {
  if (event.data && event.data.size > 0) {
    recordedChunks.push(event.data);
  }
}

async function onRecorderStop() {
  const chunks = recordedChunks.slice();
  const mimeType = mediaRecorder?.mimeType || chunks[0]?.type || "audio/webm";

  cleanupRecorderResources();
  resetRecordingTimer();
  setRecordButtonState("idle");

  if (!chunks.length) {
    setAppState(resolveFallbackState(), "Запись остановлена, но аудио-данные не получены.");
    return;
  }

  const recordedBlob = new Blob(chunks, { type: mimeType });
  if (!recordedBlob.size) {
    setAppState(resolveFallbackState(), "Запись остановлена, но получен пустой аудиофайл.");
    return;
  }

  const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    const wavFile = await convertRecordedBlobToWavFile(recordedBlob, safeStamp);
    await loadInputFile(wavFile, "Запись завершена.");
  } catch (error) {
    setAppState(
      resolveFallbackState(),
      `Запись получена, но не удалось подготовить WAV: ${error?.message || "неизвестная ошибка"}.`,
    );
  }
}

function onRecorderError(event) {
  const message = event?.error?.message || "Ошибка MediaRecorder";
  cleanupRecorderResources();
  resetRecordingTimer();
  setRecordButtonState("idle");
  setAppState(resolveFallbackState(), `Ошибка записи: ${message}`);
}

async function loadInputFile(file, sourceMessage) {
  selectedFile = file;
  uploadedId = "";
  processedDownloadUrl = "";

  resetProcessedOutput();

  fileInfo.classList.remove("hidden");
  originalPanel.classList.remove("hidden");
  processBtn.classList.remove("hidden");
  processBtn.disabled = true;

  fileNameEl.textContent = file.name;

  const localUrl = URL.createObjectURL(file);
  setOriginalAudioSource(localUrl);
  try {
    await drawWaveformFromSource(localUrl, originalWave);
  } catch (_) {
    // Fallback to player even if waveform decoding fails.
  }

  setAppState(APP_STATES.RECORDED, `${sourceMessage} Загружаем входной файл на сервер...`);

  try {
    uploadedId = await uploadInputFile(file);
    processBtn.disabled = false;
    setAppState(APP_STATES.RECORDED, "Входной файл готов. Нажмите «Очистить от пауз».");
  } catch (error) {
    setAppState(APP_STATES.RECORDED, `Ошибка загрузки: ${error.message}`);
  }
}

function setOriginalAudioSource(sourceUrl) {
  if (originalObjectUrl) {
    URL.revokeObjectURL(originalObjectUrl);
    originalObjectUrl = "";
  }

  originalAudio.src = sourceUrl;
  if (sourceUrl.startsWith("blob:")) {
    originalObjectUrl = sourceUrl;
  }
}

function resetProcessedOutput() {
  resultPanel.classList.add("hidden");
  downloadProcessedBtn.classList.add("hidden");
  ratioValue.textContent = "-";
  resultAudio.removeAttribute("src");
  resultAudio.load();
}

async function uploadInputFile(file) {
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
  return payload.id;
}

async function onProcessClick() {
  if (!uploadedId) {
    setAppState(resolveFallbackState(), "Сначала дождитесь загрузки входного файла.");
    return;
  }

  processBtn.disabled = true;
  setAppState(APP_STATES.PROCESSING, "Идет обработка...");

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

    setAppState(APP_STATES.PROCESSED, "Обработка завершена. Можно сравнить исходный и итоговый файл.");
  } catch (error) {
    setAppState(resolveFallbackState(), `Ошибка обработки: ${error.message}`);
  } finally {
    processBtn.disabled = !uploadedId;
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
    setAppState(resolveFallbackState(), `Ошибка скачивания: ${error.message}`);
  }
}

function setAppState(nextState, message) {
  appState = nextState;
  if (message) {
    statusEl.textContent = message;
  }
}

function resolveFallbackState() {
  return selectedFile ? APP_STATES.RECORDED : APP_STATES.IDLE;
}

function setRecordButtonState(mode) {
  recordBtn.classList.remove("danger");

  if (mode === "requesting") {
    recordBtn.textContent = "Разрешение...";
    recordBtn.disabled = true;
    return;
  }

  if (mode === "recording") {
    recordBtn.textContent = "Остановить запись";
    recordBtn.disabled = false;
    recordBtn.classList.add("danger");
    return;
  }

  if (mode === "stopping") {
    recordBtn.textContent = "Останавливаем...";
    recordBtn.disabled = true;
    recordBtn.classList.add("danger");
    return;
  }

  recordBtn.textContent = "Начать запись";
  recordBtn.disabled = !isRecordingSupported();
}

function isRecordingSupported() {
  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

function pickRecorderOptions() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }

  for (const mimeType of RECORDER_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType };
    }
  }

  return null;
}

function mapRecordingStartError(error) {
  const name = error?.name || "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Доступ к микрофону запрещен пользователем.";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Микрофон не найден.";
  }

  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "Микрофон недоступен. Проверьте, не используется ли он другим приложением.";
  }

  return `Не удалось начать запись: ${error?.message || "неизвестная ошибка"}`;
}

async function convertRecordedBlobToWavFile(blob, safeStamp) {
  const audioBuffer = await decodeBlobToAudioBuffer(blob);
  const wavBuffer = audioBufferToWav(audioBuffer);
  return new File([wavBuffer], `recording_${safeStamp}.wav`, { type: "audio/wav" });
}

async function decodeBlobToAudioBuffer(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API не поддерживается");
  }

  const audioContext = new AudioCtx();
  try {
    return await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioContext.close();
  }
}

function audioBufferToWav(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = audioBuffer.getChannelData(ch)[i];
      const clamped = Math.max(-1, Math.min(1, sample));
      const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function cleanupRecorderResources() {
  stopRecordingTimer();

  if (mediaRecorder) {
    mediaRecorder.removeEventListener("dataavailable", onRecorderDataAvailable);
    mediaRecorder.removeEventListener("stop", onRecorderStop);
    mediaRecorder.removeEventListener("error", onRecorderError);
    mediaRecorder = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  recordedChunks = [];
}

function startRecordingTimer() {
  stopRecordingTimer();
  recordingStartedAt = Date.now();
  recordTimerEl.classList.remove("hidden");
  updateRecordingTimer(0);

  recordTimerId = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
    updateRecordingTimer(elapsed);
  }, 1000);
}

function stopRecordingTimer() {
  if (recordTimerId) {
    clearInterval(recordTimerId);
    recordTimerId = null;
  }
}

function resetRecordingTimer() {
  stopRecordingTimer();
  updateRecordingTimer(0);
  recordTimerEl.classList.add("hidden");
}

function updateRecordingTimer(seconds) {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const sec = String(seconds % 60).padStart(2, "0");
  recordTimerEl.textContent = `${minutes}:${sec}`;
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

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API is not supported");
  }

  const audioContext = new AudioCtx();
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
