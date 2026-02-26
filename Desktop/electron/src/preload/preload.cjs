const { contextBridge, ipcRenderer } = require("electron");

let activeStream = null;
let activeRecorder = null;
let captureSequence = 0;

const chunkListeners = new Set();
const captureErrorListeners = new Set();

function emitAudioChunk(payload) {
  chunkListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("[desktop] onAudioChunk listener error:", error);
    }
  });
}

function emitCaptureError(error) {
  const message = error instanceof Error ? error.message : String(error);
  captureErrorListeners.forEach((listener) => {
    try {
      listener({ message, raw: error });
    } catch (listenerError) {
      console.error("[desktop] onCaptureError listener error:", listenerError);
    }
  });
}

function clearActiveStream() {
  if (!activeStream) return;
  activeStream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // no-op
    }
  });
  activeStream = null;
}

function pickRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function createMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  });
}

async function createSystemAudioStream(sourceId) {
  if (sourceId) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 1,
          maxHeight: 1,
          maxFrameRate: 1,
        },
      },
    });
  }

  return navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });
}

async function stopAudioCapture() {
  const recorder = activeRecorder;
  activeRecorder = null;

  if (recorder && recorder.state !== "inactive") {
    await new Promise((resolve) => {
      const done = () => resolve();
      recorder.addEventListener("stop", done, { once: true });
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
  }

  clearActiveStream();

  try {
    await ipcRenderer.invoke("desktop:stopCapture");
  } catch (error) {
    console.warn("[desktop] stopCapture notify failed:", error);
  }

  return { ok: true };
}

async function startAudioCapture(options = {}) {
  if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
    const error = new Error("Audio capture is not supported in this environment");
    emitCaptureError(error);
    return { ok: false, error: error.message };
  }

  await stopAudioCapture();
  captureSequence = 0;

  const inputSource =
    options.inputSource === "system_audio" ? "system_audio" : "microphone";
  let resolvedSourceId =
    typeof options.sourceId === "string" && options.sourceId.trim()
      ? options.sourceId
      : null;

  try {
    if (inputSource === "system_audio" && !resolvedSourceId) {
      const sources = await ipcRenderer.invoke("desktop:getAudioSources");
      if (Array.isArray(sources) && sources.length > 0) {
        resolvedSourceId = sources[0].id;
      }
    }

    activeStream =
      inputSource === "system_audio"
        ? await createSystemAudioStream(resolvedSourceId)
        : await createMicrophoneStream();

    // システム音声キャプチャ時は映像トラックを無効化して負荷を下げる。
    activeStream.getVideoTracks().forEach((track) => {
      track.enabled = false;
    });

    const mimeType = pickRecorderMimeType();
    activeRecorder = mimeType
      ? new MediaRecorder(activeStream, { mimeType })
      : new MediaRecorder(activeStream);

    activeRecorder.addEventListener("dataavailable", async (event) => {
      if (!event.data || event.data.size === 0) return;
      const buffer = await event.data.arrayBuffer();
      emitAudioChunk({
        sequence: captureSequence++,
        receivedAt: Date.now(),
        byteLength: buffer.byteLength,
        mimeType: activeRecorder?.mimeType || event.data.type || "application/octet-stream",
        buffer,
      });
    });

    activeRecorder.addEventListener("error", (event) => {
      emitCaptureError(event.error || new Error("MediaRecorder error"));
    });

    activeRecorder.addEventListener("stop", () => {
      clearActiveStream();
    });

    const chunkMs =
      typeof options.chunkMs === "number" && options.chunkMs >= 250
        ? Math.floor(options.chunkMs)
        : 2000;

    await ipcRenderer.invoke("desktop:startCapture", {
      inputSource,
      sourceId: resolvedSourceId,
    });

    activeRecorder.start(chunkMs);

    return {
      ok: true,
      inputSource,
      sourceId: resolvedSourceId,
      mimeType: activeRecorder.mimeType || null,
      chunkMs,
    };
  } catch (error) {
    emitCaptureError(error);
    await stopAudioCapture();
    return {
      ok: false,
      inputSource,
      sourceId: resolvedSourceId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function onCaptureStateChanged(callback) {
  const listener = (_event, payload) => {
    callback(payload);
  };
  ipcRenderer.on("desktop:captureStateChanged", listener);
  return () => {
    ipcRenderer.removeListener("desktop:captureStateChanged", listener);
  };
}

function onAudioChunk(callback) {
  chunkListeners.add(callback);
  return () => {
    chunkListeners.delete(callback);
  };
}

function onCaptureError(callback) {
  captureErrorListeners.add(callback);
  return () => {
    captureErrorListeners.delete(callback);
  };
}

contextBridge.exposeInMainWorld("desktopAPI", {
  getAudioSources: () => ipcRenderer.invoke("desktop:getAudioSources"),
  startAudioCapture,
  stopAudioCapture,
  startCapture: () => ipcRenderer.invoke("desktop:startCapture"),
  stopCapture: () => ipcRenderer.invoke("desktop:stopCapture"),
  getPermissions: () => ipcRenderer.invoke("desktop:getPermissions"),
  openSettings: (target) => ipcRenderer.invoke("desktop:openSettings", target),
  onCaptureStateChanged,
  onAudioChunk,
  onCaptureError,
});
