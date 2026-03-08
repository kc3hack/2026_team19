declare module "*.css";

type DesktopInputSource = "microphone" | "system_audio";

type DesktopAudioSource = {
  id: string;
  name: string;
  displayId: string;
  appIcon: string | null;
};

type DesktopAudioCaptureOptions = {
  inputSource?: DesktopInputSource;
  sourceId?: string | null;
  chunkMs?: number;
};

type DesktopAudioChunk = {
  sequence: number;
  receivedAt: number;
  byteLength: number;
  mimeType: string;
  buffer: ArrayBuffer;
};

type DesktopCaptureState = {
  isCapturing: boolean;
  inputSource: DesktopInputSource;
  sourceId: string | null;
  updatedAt: number;
};

type DesktopCaptureResult = {
  ok: boolean;
  isCapturing?: boolean;
  inputSource?: DesktopInputSource;
  sourceId?: string | null;
  mimeType?: string | null;
  chunkMs?: number;
  error?: string;
};

type DesktopPermissions = {
  microphone: string;
  screen: string;
};

type DesktopTrayTermSummary = {
  term: string;
  description: string;
};

type DesktopTraySummaryPayload = {
  transcriptSummary: string;
  terms: DesktopTrayTermSummary[];
};

type DesktopTrayCommand =
  | { type: "start-capture"; inputSource: DesktopInputSource }
  | { type: "stop-capture" }
  | { type: "set-input-source"; inputSource: DesktopInputSource; restartIfCapturing?: boolean };

interface Window {
  desktopAPI?: {
    getAudioSources: () => Promise<DesktopAudioSource[]>;
    startAudioCapture: (options?: DesktopAudioCaptureOptions) => Promise<DesktopCaptureResult>;
    stopAudioCapture: () => Promise<DesktopCaptureResult>;
    startCapture: () => Promise<DesktopCaptureResult>;
    stopCapture: () => Promise<DesktopCaptureResult>;
    updateTraySummary: (payload: DesktopTraySummaryPayload) => Promise<{ ok: boolean }>;
    getPermissions: () => Promise<DesktopPermissions>;
    openSettings: (target: "microphone" | "screen") => Promise<{ ok: boolean }>;
    getAutoLaunch: () => Promise<{ openAtLogin: boolean }>;
    setAutoLaunch: (enabled: boolean) => Promise<{ ok: boolean; openAtLogin: boolean }>;
    onCaptureStateChanged: (callback: (state: DesktopCaptureState) => void) => () => void;
    onAudioChunk: (callback: (chunk: DesktopAudioChunk) => void) => () => void;
    onCaptureError: (callback: (payload: { message: string; raw?: unknown }) => void) => () => void;
    onTrayCommand: (callback: (command: DesktopTrayCommand) => void) => () => void;
  };
}
