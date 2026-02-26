const path = require("node:path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  desktopCapturer,
  shell,
  systemPreferences,
} = require("electron");

const APP_NAME = "TalkScope Desktop";
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "";
const isMac = process.platform === "darwin";

let mainWindow = null;
let tray = null;
let isQuitting = false;
let isCapturing = false;
let captureInputSource = "microphone";
let captureSourceId = null;

const PRIVACY_SETTINGS_URLS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

function createTrayIcon() {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="8" fill="black"/>
  </svg>`;
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  const icon = nativeImage.createFromDataURL(dataUrl).resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  return icon;
}

function createMainWindow() {
  if (mainWindow) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  loadRenderer(mainWindow);
  return mainWindow;
}

function loadRenderer(win) {
  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
    return;
  }

  const filePath = path.resolve(__dirname, "../../../../Frontend/dist/index.html");
  win.loadFile(filePath);
}

function showMainWindow() {
  const win = createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideMainWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
}

function emitCaptureState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("desktop:captureStateChanged", {
    isCapturing,
    inputSource: captureInputSource,
    sourceId: captureSourceId,
    updatedAt: Date.now(),
  });
}

function emitTrayCommand(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send("desktop:trayCommand", payload);
  return true;
}

function createTray() {
  if (tray) return;

  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on("click", () => {
    if (!mainWindow || !mainWindow.isVisible()) {
      showMainWindow();
      return;
    }
    hideMainWindow();
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;

  const menu = Menu.buildFromTemplate([
    {
      label: "ウィンドウを開く",
      click: showMainWindow,
    },
    { type: "separator" },
    {
      label: "入力ソース",
      submenu: [
        {
          label: "マイク入力",
          type: "radio",
          checked: captureInputSource === "microphone",
          click: () => {
            captureInputSource = "microphone";
            emitCaptureState();
            if (isCapturing) {
              emitTrayCommand({
                type: "set-input-source",
                inputSource: "microphone",
                restartIfCapturing: true,
              });
            }
            refreshTrayMenu();
          },
        },
        {
          label: "システム音声",
          type: "radio",
          checked: captureInputSource === "system_audio",
          click: () => {
            captureInputSource = "system_audio";
            emitCaptureState();
            if (isCapturing) {
              emitTrayCommand({
                type: "set-input-source",
                inputSource: "system_audio",
                restartIfCapturing: true,
              });
            }
            refreshTrayMenu();
          },
        },
      ],
    },
    {
      label: isCapturing ? "音声取得を停止" : "音声取得を開始",
      click: () => {
        if (isCapturing) {
          emitTrayCommand({ type: "stop-capture" });
          return;
        }
        emitTrayCommand({
          type: "start-capture",
          inputSource: captureInputSource,
        });
      },
    },
    {
      label: openAtLogin ? "ログイン時起動を無効化" : "ログイン時起動を有効化",
      click: () => {
        app.setLoginItemSettings({ openAtLogin: !openAtLogin });
        refreshTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "終了",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function getPermissionStatus() {
  const microphone = systemPreferences.getMediaAccessStatus("microphone");
  let screen = "unknown";

  // screen は macOS 向け。未対応環境は unknown にする。
  try {
    screen = systemPreferences.getMediaAccessStatus("screen");
  } catch {
    screen = "unknown";
  }

  return { microphone, screen };
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:getAudioSources", async () => {
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: true,
      });
    } catch (error) {
      console.error("[desktop] failed to get audio sources:", error);
      return [];
    }

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id ?? "",
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
    }));
  });

  ipcMain.handle("desktop:startCapture", async (_event, payload = {}) => {
    captureInputSource =
      payload && payload.inputSource === "system_audio"
        ? "system_audio"
        : "microphone";
    captureSourceId =
      payload && typeof payload.sourceId === "string" && payload.sourceId.trim()
        ? payload.sourceId
        : null;
    isCapturing = true;
    emitCaptureState();
    refreshTrayMenu();
    return {
      ok: true,
      isCapturing,
      inputSource: captureInputSource,
      sourceId: captureSourceId,
    };
  });

  ipcMain.handle("desktop:stopCapture", async () => {
    isCapturing = false;
    captureSourceId = null;
    emitCaptureState();
    refreshTrayMenu();
    return { ok: true, isCapturing, inputSource: captureInputSource, sourceId: null };
  });

  ipcMain.handle("desktop:getPermissions", async () => {
    return getPermissionStatus();
  });

  ipcMain.handle("desktop:openSettings", async (_event, target) => {
    const key = target === "screen" ? "screen" : "microphone";
    if (isMac && PRIVACY_SETTINGS_URLS[key]) {
      await shell.openExternal(PRIVACY_SETTINGS_URLS[key]);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle("desktop:getAutoLaunch", async () => {
    return { openAtLogin: app.getLoginItemSettings().openAtLogin };
  });

  ipcMain.handle("desktop:setAutoLaunch", async (_event, payload = {}) => {
    const enabled = Boolean(payload && payload.enabled);
    app.setLoginItemSettings({ openAtLogin: enabled });
    refreshTrayMenu();
    return { ok: true, openAtLogin: app.getLoginItemSettings().openAtLogin };
  });
}

function ensureSingleInstance() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => {
    showMainWindow();
  });

  return true;
}

function setupAppEvents() {
  app.on("activate", () => {
    showMainWindow();
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("window-all-closed", () => {
    if (!isMac) {
      app.quit();
    }
  });
}

async function bootstrap() {
  if (!ensureSingleInstance()) return;

  setupAppEvents();
  app.setName(APP_NAME);
  await app.whenReady();

  createMainWindow();
  createTray();
  registerIpcHandlers();

  // 最初は常駐重視で非表示起動。明示操作で表示する。
  hideMainWindow();
}

bootstrap().catch((error) => {
  console.error("[desktop] bootstrap error:", error);
  app.quit();
});
