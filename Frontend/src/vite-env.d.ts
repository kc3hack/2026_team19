/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_VECTOR_API_URL?: string;
  readonly VITE_VECTOR_OVERLAP_SENTENCES?: string;
  readonly VITE_VECTOR_SEND_EVERY_N_SENTENCES?: string;
  readonly VITE_VECTOR_SEND_INTERVAL_SEC?: string;
  readonly VITE_DESKTOP_CAPTURE_TRANSPORT?: 'post' | 'swift_ws';
  readonly VITE_SWIFT_AGENT_WS_URL?: string;
  readonly VITE_SWIFT_AGENT_WS_PROTOCOL?: string;
}
