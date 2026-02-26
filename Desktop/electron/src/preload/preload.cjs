const { contextBridge, ipcRenderer } = require("electron");

function onCaptureStateChanged(callback) {
  const listener = (_event, payload) => {
    callback(payload);
  };
  ipcRenderer.on("desktop:captureStateChanged", listener);
  return () => {
    ipcRenderer.removeListener("desktop:captureStateChanged", listener);
  };
}

contextBridge.exposeInMainWorld("desktopAPI", {
  getAudioSources: () => ipcRenderer.invoke("desktop:getAudioSources"),
  startCapture: () => ipcRenderer.invoke("desktop:startCapture"),
  stopCapture: () => ipcRenderer.invoke("desktop:stopCapture"),
  getPermissions: () => ipcRenderer.invoke("desktop:getPermissions"),
  openSettings: (target) => ipcRenderer.invoke("desktop:openSettings", target),
  onCaptureStateChanged,
});
