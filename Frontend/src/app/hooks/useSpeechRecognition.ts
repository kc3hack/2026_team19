import { useState, useEffect, useCallback, useRef } from 'react';

type CaptureInputSource = 'microphone' | 'system_audio';
type PipelineAudioFormat = 'wav' | 'pcm16' | 'webm_opus';
type DesktopCaptureTransport = 'post' | 'swift_ws';

type SwiftMessageKind = 'command' | 'event' | 'response';

type SwiftEnvelope = {
  version: string;
  kind: SwiftMessageKind;
  name: string;
  request_id?: string;
  timestamp_ms: number;
  payload: Record<string, unknown>;
};

type SwiftErrorPayload = {
  code: string;
  message: string;
  recoverable: boolean;
  hint?: string;
};

type SwiftResponsePayload = {
  ok: boolean;
  error?: SwiftErrorPayload;
  [key: string]: unknown;
};

type SwiftTranscriptPayload = {
  source: CaptureInputSource;
  text: string;
  is_final: boolean;
};

export type SwiftDictionaryEntry = {
  term: string;
  description: string;
  meaning_vector: number[] | null;
  source: string;
};

type UseSpeechRecognitionOptions = {
  onDictionaryResults?: (entries: SwiftDictionaryEntry[]) => void;
};

type StartListeningResult = {
  ok: boolean;
  mode: 'browser' | 'desktop' | 'hybrid' | 'none';
  message?: string;
};

type DesktopPipelineResponse = {
  transcript: {
    partial_text: string;
    final_text: string;
    is_final: boolean;
  };
};

type PipelineSendOptions = {
  isFinalChunk?: boolean;
  includeDictionary?: boolean;
  textOverride?: string;
  audioFormatOverride?: PipelineAudioFormat;
};

interface UseSpeechRecognitionReturn {
  transcript: string;
  setTranscript: (text: string) => void;
  isListening: boolean;
  startListening: () => Promise<StartListeningResult>;
  stopListening: () => Promise<void>;
  resetTranscript: () => void;
  error: string | null;
  isDesktopCaptureAvailable: boolean;
  inputSource: CaptureInputSource;
  setInputSource: (source: CaptureInputSource) => void;
  desktopAudioSources: DesktopAudioSource[];
  selectedDesktopSourceId: string | null;
  setSelectedDesktopSourceId: (id: string | null) => void;
  refreshDesktopAudioSources: () => Promise<void>;
  desktopChunkCount: number;
}

const PIPELINE_ERROR_NOTIFY_INTERVAL_MS = 5000;
const PIPELINE_REQUEST_TIMEOUT_MS = 12000;
const SWIFT_WS_COMMAND_TIMEOUT_MS = 8000;

const resolveDesktopCaptureTransport = (): DesktopCaptureTransport => {
  const raw = (import.meta.env.VITE_DESKTOP_CAPTURE_TRANSPORT ?? 'post').trim().toLowerCase();
  return raw === 'swift_ws' ? 'swift_ws' : 'post';
};

const createRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const createPipelineSessionId = (): string =>
  `desktop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const resolveAudioFormat = (mimeType: string): PipelineAudioFormat | null => {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm')) return 'webm_opus';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('pcm')) return 'pcm16';
  return null;
};

const appendCommittedTranscript = (current: string, finalText: string): string => {
  if (!finalText) return current;
  if (!current) return finalText;
  if (current.endsWith('\n')) return `${current}${finalText}`;
  return `${current}\n${finalText}`;
};

export const useSpeechRecognition = (
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn => {
  const { onDictionaryResults } = options;
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDesktopCaptureAvailable, setIsDesktopCaptureAvailable] = useState(false);
  const [inputSource, setInputSource] = useState<CaptureInputSource>('microphone');
  const [desktopAudioSources, setDesktopAudioSources] = useState<DesktopAudioSource[]>([]);
  const [selectedDesktopSourceId, setSelectedDesktopSourceId] = useState<string | null>(null);
  const [desktopChunkCount, setDesktopChunkCount] = useState(0);

  const recognitionRef = useRef<any>(null);
  const isStartingRef = useRef(false);
  const listeningRef = useRef(false);
  const recognitionActiveRef = useRef(false);
  const inputSourceRef = useRef<CaptureInputSource>('microphone');
  const browserTranscriptRef = useRef('');
  const captureTransportRef = useRef<DesktopCaptureTransport>(resolveDesktopCaptureTransport());

  const backendBaseUrlRef = useRef(
    (import.meta.env.VITE_BACKEND_URL ?? '').trim() ||
    (import.meta.env.VITE_VECTOR_API_URL ?? '').trim(),
  );
  const pipelineSessionIdRef = useRef(createPipelineSessionId());
  const pipelineNextSeqRef = useRef(0);
  const pipelineCommittedTextRef = useRef('');
  const pipelinePartialTextRef = useRef('');
  const pipelineQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastPipelineErrorAtRef = useRef(0);
  const swiftWsRef = useRef<WebSocket | null>(null);
  const swiftWsConnectingRef = useRef<Promise<WebSocket> | null>(null);
  const swiftWsPendingCommandsRef = useRef(new Map<string, {
    resolve: (payload: SwiftResponsePayload) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>());
  const swiftCommittedTextRef = useRef('');
  const swiftPartialTextBySourceRef = useRef<Partial<Record<CaptureInputSource, string>>>({});
  const swiftWsUrlRef = useRef((import.meta.env.VITE_SWIFT_AGENT_WS_URL ?? 'ws://127.0.0.1:55100/ws').trim());
  const swiftWsProtocolRef = useRef((import.meta.env.VITE_SWIFT_AGENT_WS_PROTOCOL ?? 'lexiflow.capture.v1').trim() || 'lexiflow.capture.v1');

  useEffect(() => {
    inputSourceRef.current = inputSource;
  }, [inputSource]);

  const notifyPipelineError = useCallback((message: string) => {
    const now = Date.now();
    if (now - lastPipelineErrorAtRef.current < PIPELINE_ERROR_NOTIFY_INTERVAL_MS) return;
    lastPipelineErrorAtRef.current = now;
    setError(`統合API送信エラー: ${message}`);
  }, []);

  const resetPipelineSession = useCallback(() => {
    pipelineSessionIdRef.current = createPipelineSessionId();
    pipelineNextSeqRef.current = 0;
    pipelineCommittedTextRef.current = '';
    pipelinePartialTextRef.current = '';
  }, []);

  const resetSwiftTranscriptSession = useCallback(() => {
    swiftCommittedTextRef.current = '';
    swiftPartialTextBySourceRef.current = {};
  }, []);

  const applySwiftTranscript = useCallback((payload: SwiftTranscriptPayload) => {
    const text = payload.text.trim();
    if (!text) return;

    if (payload.is_final) {
      swiftCommittedTextRef.current = appendCommittedTranscript(swiftCommittedTextRef.current, text);
      delete swiftPartialTextBySourceRef.current[payload.source];
    } else {
      swiftPartialTextBySourceRef.current[payload.source] = text;
    }

    const partials = Object.values(swiftPartialTextBySourceRef.current)
      .map((value) => value?.trim() ?? '')
      .filter(Boolean);
    const nextTranscript = [swiftCommittedTextRef.current, ...partials].filter(Boolean).join('\n');
    setTranscript(nextTranscript);
    browserTranscriptRef.current = nextTranscript;
  }, []);

  const makeSwiftEnvelope = useCallback((
    kind: SwiftMessageKind,
    name: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): SwiftEnvelope => ({
    version: '1.0.0',
    kind,
    name,
    request_id: requestId,
    timestamp_ms: Date.now(),
    payload,
  }), []);

  const handleSwiftEvent = useCallback((name: string, payload: Record<string, unknown>) => {
    switch (name) {
      case 'partial_transcript':
      case 'final_transcript': {
        const source = payload.source;
        const text = payload.text;
        const isFinal = payload.is_final;
        if (
          (source === 'microphone' || source === 'system_audio')
          && typeof text === 'string'
          && typeof isFinal === 'boolean'
        ) {
          applySwiftTranscript({ source, text, is_final: isFinal });
        }
        return;
      }
      case 'state_changed': {
        const isCapturing = payload.is_capturing;
        if (typeof isCapturing === 'boolean') {
          listeningRef.current = isCapturing;
          setIsListening(isCapturing);
        }
        return;
      }
      case 'permission_required': {
        const message = payload.message;
        if (typeof message === 'string' && message.trim()) {
          setError(message);
        }
        return;
      }
      case 'capture_stopped': {
        listeningRef.current = false;
        setIsListening(false);
        return;
      }
      case 'error': {
        const message = typeof payload.message === 'string' ? payload.message : 'unknown error';
        const code = typeof payload.code === 'string' ? payload.code : 'INTERNAL_ERROR';
        setError(`Swift Agentエラー (${code}): ${message}`);
        if (payload.recoverable === false) {
          listeningRef.current = false;
          setIsListening(false);
        }
        return;
      }
      case 'analysis_result': {
        const dictionary = payload.dictionary;
        if (!isRecord(dictionary)) return;
        const entries = dictionary.entries;
        if (!Array.isArray(entries)) return;

        const normalizedEntries: SwiftDictionaryEntry[] = entries.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          if (typeof entry.term !== 'string' || typeof entry.description !== 'string') return [];

          const meaningVector = Array.isArray(entry.meaning_vector)
            ? entry.meaning_vector.filter((value): value is number => typeof value === 'number')
            : null;

          return [{
            term: entry.term,
            description: entry.description,
            meaning_vector: meaningVector,
            source: typeof entry.source === 'string' ? entry.source : 'swift_analysis',
          }];
        });

        if (normalizedEntries.length > 0) {
          onDictionaryResults?.(normalizedEntries);
        }
        return;
      }
      default:
        return;
    }
  }, [applySwiftTranscript, onDictionaryResults]);

  const rejectAllSwiftPendingCommands = useCallback((message: string) => {
    swiftWsPendingCommandsRef.current.forEach((pending, requestId) => {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(message));
      swiftWsPendingCommandsRef.current.delete(requestId);
    });
  }, []);

  const ensureSwiftWsConnected = useCallback(async (): Promise<WebSocket> => {
    const existing = swiftWsRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) {
      return existing;
    }

    if (swiftWsConnectingRef.current) {
      return swiftWsConnectingRef.current;
    }

    const wsUrl = swiftWsUrlRef.current;
    if (!wsUrl) {
      throw new Error('VITE_SWIFT_AGENT_WS_URL が未設定です。');
    }

    const connectPromise = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl, swiftWsProtocolRef.current);
      swiftWsRef.current = ws;

      ws.onopen = () => {
        settled = true;
        swiftWsConnectingRef.current = null;
        resolve(ws);
      };

      ws.onmessage = (event) => {
        try {
          const raw = JSON.parse(String(event.data)) as unknown;
          if (!isRecord(raw)) return;
          const envelope = raw as Partial<SwiftEnvelope>;
          if (!isRecord(envelope.payload)) return;

          if (envelope.kind === 'response' && typeof envelope.request_id === 'string') {
            const pending = swiftWsPendingCommandsRef.current.get(envelope.request_id);
            if (!pending) return;
            swiftWsPendingCommandsRef.current.delete(envelope.request_id);
            window.clearTimeout(pending.timeoutId);
            const payload = envelope.payload as SwiftResponsePayload;
            if (payload.ok) {
              pending.resolve(payload);
            } else {
              const errorMessage =
                typeof payload.error?.message === 'string'
                  ? payload.error.message
                  : `Swift Agent command failed: ${envelope.name ?? 'unknown'}`;
              pending.reject(new Error(errorMessage));
            }
            return;
          }

          if (envelope.kind === 'event' && typeof envelope.name === 'string') {
            handleSwiftEvent(envelope.name, envelope.payload);
          }
        } catch (error) {
          console.warn('Failed to parse Swift Agent WS message', error);
        }
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        swiftWsConnectingRef.current = null;
        reject(new Error('Swift Agent へのWebSocket接続に失敗しました。'));
      };

      ws.onclose = () => {
        swiftWsRef.current = null;
        swiftWsConnectingRef.current = null;
        rejectAllSwiftPendingCommands('Swift Agent との接続が切断されました。');
        if (!settled) {
          settled = true;
          reject(new Error('Swift Agent との接続が閉じられました。'));
          return;
        }
        if (captureTransportRef.current === 'swift_ws') {
          listeningRef.current = false;
          setIsListening(false);
        }
      };
    });

    swiftWsConnectingRef.current = connectPromise;
    return connectPromise;
  }, [handleSwiftEvent, rejectAllSwiftPendingCommands]);

  const closeSwiftWs = useCallback(() => {
    rejectAllSwiftPendingCommands('Swift Agent との接続を終了しました。');
    const ws = swiftWsRef.current;
    swiftWsRef.current = null;
    swiftWsConnectingRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'client_cleanup');
    }
  }, [rejectAllSwiftPendingCommands]);

  const sendSwiftCommand = useCallback(async (
    name: string,
    payload: Record<string, unknown>,
  ): Promise<SwiftResponsePayload> => {
    const ws = await ensureSwiftWsConnected();
    const requestId = createRequestId();
    const envelope = makeSwiftEnvelope('command', name, payload, requestId);

    return new Promise<SwiftResponsePayload>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        swiftWsPendingCommandsRef.current.delete(requestId);
        reject(new Error(`Swift Agent command timeout: ${name}`));
      }, SWIFT_WS_COMMAND_TIMEOUT_MS);

      swiftWsPendingCommandsRef.current.set(requestId, { resolve, reject, timeoutId });

      try {
        ws.send(JSON.stringify(envelope));
      } catch (error) {
        window.clearTimeout(timeoutId);
        swiftWsPendingCommandsRef.current.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, [ensureSwiftWsConnected, makeSwiftEnvelope]);

  const validateCapturePermission = useCallback(async (
    source: CaptureInputSource,
  ): Promise<string | null> => {
    const desktopAPI = window.desktopAPI;
    if (!desktopAPI?.getPermissions) return null;

    try {
      const permissions = await desktopAPI.getPermissions();
      if (source === 'system_audio' && permissions.screen === 'denied') {
        return '画面収録権限が拒否されています。システム設定で許可してください。';
      }
      if (source === 'microphone' && permissions.microphone === 'denied') {
        return 'マイク権限が拒否されています。システム設定で許可してください。';
      }
      return null;
    } catch (error) {
      console.warn('Failed to check desktop permissions', error);
      return null;
    }
  }, []);

  const applyPipelineTranscript = useCallback((payload: DesktopPipelineResponse) => {
    const shouldReflect =
      inputSourceRef.current === 'system_audio' || !recognitionActiveRef.current;
    if (!shouldReflect) return;

    const partialText = payload.transcript.partial_text.trim();
    const finalText = payload.transcript.final_text.trim();

    if (payload.transcript.is_final) {
      pipelineCommittedTextRef.current = appendCommittedTranscript(
        pipelineCommittedTextRef.current,
        finalText,
      );
      pipelinePartialTextRef.current = '';
    } else {
      pipelinePartialTextRef.current = partialText;
    }

    const nextTranscript = [pipelineCommittedTextRef.current, pipelinePartialTextRef.current]
      .filter(Boolean)
      .join('\n');
    setTranscript(nextTranscript);
  }, []);

  const sendPipelineChunk = useCallback(async (
    chunk: DesktopAudioChunk,
    options: PipelineSendOptions = {},
  ) => {
    const baseUrl = backendBaseUrlRef.current;
    if (!baseUrl) return;

    const audioFormat = options.audioFormatOverride ?? resolveAudioFormat(chunk.mimeType);
    if (!audioFormat) {
      notifyPipelineError(`unsupported mimeType: ${chunk.mimeType}`);
      return;
    }

    const sessionId = pipelineSessionIdRef.current || createPipelineSessionId();
    pipelineSessionIdRef.current = sessionId;

    const chunkSeq = pipelineNextSeqRef.current;
    const isFinalChunk = Boolean(options.isFinalChunk);
    const includeDictionary = Boolean(options.includeDictionary);

    let textOverride = options.textOverride;
    if (typeof textOverride === 'undefined' && inputSourceRef.current === 'microphone') {
      const currentBrowserTranscript = browserTranscriptRef.current.trim();
      if (currentBrowserTranscript) {
        textOverride = currentBrowserTranscript;
      }
    }

    const audioBlob = new Blob([chunk.buffer], { type: chunk.mimeType || 'application/octet-stream' });
    const fileExt = audioFormat === 'webm_opus' ? 'webm' : audioFormat === 'pcm16' ? 'pcm' : 'wav';
    const form = new FormData();
    form.append('audio', audioBlob, `chunk-${chunkSeq}.${fileExt}`);
    form.append('session_id', sessionId);
    form.append('chunk_seq', String(chunkSeq));
    form.append('is_final_chunk', String(isFinalChunk));
    form.append('input_source', inputSourceRef.current);
    form.append('audio_format', audioFormat);
    form.append('sample_rate_hz', '16000');
    form.append('channels', '1');
    form.append('language_hint', 'ja-JP');
    form.append('include_dictionary', String(includeDictionary));
    form.append('dictionary_top_k', '5');
    form.append('deduplicate', 'false');
    form.append('min_length', '1');
    form.append('normalize_sentence_vector', 'true');
    if (textOverride) {
      form.append('text_override', textOverride);
    }

    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), PIPELINE_REQUEST_TIMEOUT_MS);
      const response = await fetch(`${baseUrl}/pipeline/transcribe-analyze`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      }).finally(() => {
        window.clearTimeout(timeoutId);
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const body = await response.json().catch(() => ({}));
          const detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body);
          throw new Error(`HTTP ${response.status}: ${detail}`);
        }
        const bodyText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${bodyText || 'unknown error'}`);
      }

      const payload = (await response.json()) as DesktopPipelineResponse;
      pipelineNextSeqRef.current = chunkSeq + 1;
      applyPipelineTranscript(payload);

      if (isFinalChunk) {
        resetPipelineSession();
      }
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';
      const message = isTimeout
        ? `request timeout (${PIPELINE_REQUEST_TIMEOUT_MS}ms)`
        : error instanceof Error ? error.message : String(error);
      notifyPipelineError(message);
      resetPipelineSession();
    }
  }, [applyPipelineTranscript, notifyPipelineError, resetPipelineSession]);

  const enqueuePipelineChunk = useCallback((chunk: DesktopAudioChunk, options: PipelineSendOptions = {}) => {
    if (captureTransportRef.current !== 'post') return;
    if (!backendBaseUrlRef.current) return;
    pipelineQueueRef.current = pipelineQueueRef.current
      .then(() => sendPipelineChunk(chunk, options))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        notifyPipelineError(message);
      });
  }, [notifyPipelineError, sendPipelineChunk]);

  const flushPipelineFinalChunk = useCallback(async () => {
    if (captureTransportRef.current !== 'post') return;
    if (!backendBaseUrlRef.current) return;

    const finalText = browserTranscriptRef.current.trim();
    if (inputSourceRef.current === 'microphone' && !finalText) {
      resetPipelineSession();
      return;
    }

    const finalChunk: DesktopAudioChunk = {
      sequence: -1,
      receivedAt: Date.now(),
      byteLength: 1,
      mimeType: 'audio/wav',
      buffer: new Uint8Array([0]).buffer,
    };

    pipelineQueueRef.current = pipelineQueueRef.current.then(() =>
      sendPipelineChunk(finalChunk, {
        isFinalChunk: true,
        includeDictionary: true,
        textOverride: finalText || undefined,
        audioFormatOverride: 'wav',
      }),
    );
    await pipelineQueueRef.current;
  }, [resetPipelineSession, sendPipelineChunk]);

  const refreshDesktopAudioSources = useCallback(async () => {
    if (!window.desktopAPI?.getAudioSources) return;
    try {
      const sources = await window.desktopAPI.getAudioSources();
      setDesktopAudioSources(sources);
      setSelectedDesktopSourceId((current) => {
        if (current && sources.some((source) => source.id === current)) return current;
        return sources[0]?.id ?? null;
      });
    } catch (e) {
      console.error('Failed to load desktop audio sources', e);
      setError('デスクトップ音声ソースの取得に失敗しました。');
    }
  }, []);

  const startBrowserRecognition = useCallback((): boolean => {
    if (!recognitionRef.current || recognitionActiveRef.current) return false;
    try {
      recognitionRef.current.start();
      recognitionActiveRef.current = true;
      return true;
    } catch (e) {
      console.error('Failed to start recognition', e);
      return false;
    }
  }, []);

  const stopBrowserRecognition = useCallback(() => {
    recognitionActiveRef.current = false;
    try { recognitionRef.current?.stop(); } catch (e) { }
  }, []);

  useEffect(() => {
    const hasDesktopCapture = Boolean(window.desktopAPI?.startAudioCapture);
    setIsDesktopCaptureAvailable(hasDesktopCapture);

    if (hasDesktopCapture) {
      void refreshDesktopAudioSources();
    }

    if (captureTransportRef.current === 'swift_ws') {
      void ensureSwiftWsConnected()
        .then(async () => {
          try {
            await sendSwiftCommand('hello', {
              client: 'electron',
              protocol_version: '1.0.0',
            });
          } catch (error) {
            console.warn('Swift hello command failed', error);
          }
          try {
            await sendSwiftCommand('get_status', {});
          } catch (error) {
            console.warn('Swift get_status command failed', error);
          }
        })
        .catch((error) => {
          setError(error instanceof Error ? error.message : String(error));
        });
    }

    const offChunk = window.desktopAPI?.onAudioChunk((chunk) => {
      if (captureTransportRef.current !== 'post') return;
      setDesktopChunkCount((current) => current + 1);
      enqueuePipelineChunk(chunk, {
        isFinalChunk: false,
        includeDictionary: false,
      });
    });

    const offCaptureError = window.desktopAPI?.onCaptureError((payload) => {
      console.error('Desktop audio capture error', payload);
      setError(`デスクトップ音声キャプチャエラー: ${payload.message}`);
      // system_audio 時のみ録音停止。microphone 時は Web Speech 継続を許可する。
      if (inputSourceRef.current === 'system_audio' || !recognitionActiveRef.current) {
        setIsListening(false);
        listeningRef.current = false;
      }
    });

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'ja-JP';

      recognition.onresult = (event: any) => {
        let currentTranscript = '';

        for (let i = 0; i < event.results.length; i++) {
          const text: string = event.results[i][0].transcript;
          const isFinal: boolean = event.results[i].isFinal;

          if (isFinal) currentTranscript += text + '。\n';
          else currentTranscript += text;
        }
        browserTranscriptRef.current = currentTranscript;
        setTranscript(currentTranscript);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setError(`音声認識エラー: ${event.error}`);
        recognitionActiveRef.current = false;
        if (inputSourceRef.current === 'microphone') {
          setIsListening(false);
          listeningRef.current = false;
        }
      };

      recognition.onend = () => {
        // microphone モード中は自動再開
        if (listeningRef.current && inputSourceRef.current === 'microphone') {
          try {
            recognition.start();
            recognitionActiveRef.current = true;
          } catch (e) {
            recognitionActiveRef.current = false;
          }
        }
      };

      recognitionRef.current = recognition;
    } else if (!hasDesktopCapture) {
      setError('お使いのブラウザは音声認識をサポートしていません。Chromeなどの主要なブラウザをご利用ください。');
    }

    return () => {
      offChunk?.();
      offCaptureError?.();
      stopBrowserRecognition();
      closeSwiftWs();
      void window.desktopAPI?.stopAudioCapture?.();
    };
  }, [
    closeSwiftWs,
    enqueuePipelineChunk,
    ensureSwiftWsConnected,
    refreshDesktopAudioSources,
    sendSwiftCommand,
    stopBrowserRecognition,
  ]);

  const startListeningForSource = useCallback(async (
    source: CaptureInputSource,
  ): Promise<StartListeningResult> => {
    if (isStartingRef.current || listeningRef.current) {
      return { ok: false, mode: 'none', message: 'すでに開始中です。' };
    }

    inputSourceRef.current = source;
    setInputSource(source);
    isStartingRef.current = true;
    setError(null);
    setDesktopChunkCount(0);
    resetPipelineSession();
    resetSwiftTranscriptSession();

    try {
      if (captureTransportRef.current === 'swift_ws') {
        let swiftSourceId: string | undefined;
        if (source === 'system_audio') {
          if (!isDesktopCaptureAvailable || !window.desktopAPI?.getAudioSources) {
            return { ok: false, mode: 'none', message: 'システム音声キャプチャはDesktop実行時のみ利用できます。' };
          }

          let sourceId = selectedDesktopSourceId;
          if (!sourceId) {
            const sources = await window.desktopAPI.getAudioSources();
            setDesktopAudioSources(sources);
            if (sources.length === 0) {
              return { ok: false, mode: 'none', message: 'システム音声の取得対象が見つかりません。' };
            }
            sourceId = sources[0].id;
            setSelectedDesktopSourceId(sourceId);
          }
          swiftSourceId = sourceId;
        }

        const swiftSessionId = pipelineSessionIdRef.current || createPipelineSessionId();
        pipelineSessionIdRef.current = swiftSessionId;

        await sendSwiftCommand('start_capture', {
          session_id: swiftSessionId,
          sources: [source],
          source_id: swiftSourceId,
          language: 'ja-JP',
          emit_partials: true,
          analyze_on_final: true,
          include_dictionary: true,
        });

        listeningRef.current = true;
        setIsListening(true);
        browserTranscriptRef.current = '';
        setTranscript('');
        return {
          ok: true,
          mode: 'desktop',
          message: 'Swift Agent 経由で音声認識を開始しました。',
        };
      }

      const permissionError = await validateCapturePermission(source);
      if (permissionError) {
        return { ok: false, mode: 'none', message: permissionError };
      }

      if (source === 'system_audio') {
        if (!isDesktopCaptureAvailable || !window.desktopAPI?.startAudioCapture) {
          return { ok: false, mode: 'none', message: 'システム音声キャプチャはDesktop実行時のみ利用できます。' };
        }

        let sourceId = selectedDesktopSourceId;
        if (!sourceId) {
          const sources = await window.desktopAPI.getAudioSources();
          setDesktopAudioSources(sources);
          if (sources.length === 0) {
            return { ok: false, mode: 'none', message: 'システム音声の取得対象が見つかりません。' };
          }
          sourceId = sources[0].id;
          setSelectedDesktopSourceId(sourceId);
        }

        const result = await window.desktopAPI.startAudioCapture({
          inputSource: 'system_audio',
          sourceId,
          chunkMs: 2000,
        });
        if (!result.ok) {
          return { ok: false, mode: 'none', message: result.error || '音声キャプチャの開始に失敗しました。' };
        }

        listeningRef.current = true;
        setIsListening(true);
        browserTranscriptRef.current = '';
        setTranscript('');
        return {
          ok: true,
          mode: 'desktop',
          message: backendBaseUrlRef.current
            ? 'システム音声チャンクを統合APIへ送信中です。'
            : 'バックエンドURL未設定のため、チャンク送信は無効です。',
        };
      }

      // microphone: 文字起こしは Web Speech を優先。Desktop時はチャンク取得も並行。
      const browserStarted = startBrowserRecognition();
      let desktopStarted = false;

      if (isDesktopCaptureAvailable && window.desktopAPI?.startAudioCapture) {
        const desktopResult = await window.desktopAPI.startAudioCapture({
          inputSource: 'microphone',
          chunkMs: 2000,
        });
        desktopStarted = Boolean(desktopResult.ok);
      }

      if (!browserStarted && !desktopStarted) {
        return { ok: false, mode: 'none', message: '録音を開始できませんでした。' };
      }

      listeningRef.current = true;
      setIsListening(true);
      return {
        ok: true,
        mode: browserStarted && desktopStarted ? 'hybrid' : browserStarted ? 'browser' : 'desktop',
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`音声キャプチャエラー: ${message}`);
      listeningRef.current = false;
      setIsListening(false);
      return { ok: false, mode: 'none', message };
    } finally {
      isStartingRef.current = false;
    }
  }, [
    isDesktopCaptureAvailable,
    resetPipelineSession,
    resetSwiftTranscriptSession,
    selectedDesktopSourceId,
    sendSwiftCommand,
    startBrowserRecognition,
    validateCapturePermission,
  ]);

  const startListening = useCallback(() => {
    return startListeningForSource(inputSourceRef.current);
  }, [startListeningForSource]);

  const stopListening = useCallback(async () => {
    listeningRef.current = false;
    setIsListening(false);
    stopBrowserRecognition();
    if (captureTransportRef.current === 'swift_ws') {
      try {
        await sendSwiftCommand('stop_capture', { reason: 'user_requested' });
      } catch (error) {
        console.warn('Swift stop_capture command failed', error);
      }
      return;
    }
    if (window.desktopAPI?.stopAudioCapture) {
      await window.desktopAPI.stopAudioCapture();
    }
    await flushPipelineFinalChunk();
  }, [flushPipelineFinalChunk, sendSwiftCommand, stopBrowserRecognition]);

  useEffect(() => {
    if (!window.desktopAPI?.onTrayCommand) return;

    const offTrayCommand = window.desktopAPI.onTrayCommand(async (command) => {
      if (command.type === 'stop-capture') {
        if (listeningRef.current) {
          await stopListening();
        }
        return;
      }

      if (command.type === 'start-capture') {
        if (listeningRef.current) return;
        const result = await startListeningForSource(command.inputSource);
        if (!result.ok && result.message) {
          setError(result.message);
        }
        return;
      }

      if (command.type === 'set-input-source') {
        if (command.restartIfCapturing && listeningRef.current) {
          await stopListening();
          inputSourceRef.current = command.inputSource;
          setInputSource(command.inputSource);
          const result = await startListeningForSource(command.inputSource);
          if (!result.ok && result.message) {
            setError(result.message);
          }
          return;
        }

        inputSourceRef.current = command.inputSource;
        setInputSource(command.inputSource);
      }
    });

    return () => {
      offTrayCommand();
    };
  }, [startListeningForSource, stopListening]);

  const resetTranscript = useCallback(() => {
    browserTranscriptRef.current = '';
    resetPipelineSession();
    resetSwiftTranscriptSession();
    setTranscript('');
  }, [resetPipelineSession, resetSwiftTranscriptSession]);

  return {
    transcript,
    setTranscript,
    isListening,
    startListening,
    stopListening,
    resetTranscript,
    error,
    isDesktopCaptureAvailable,
    inputSource,
    setInputSource,
    desktopAudioSources,
    selectedDesktopSourceId,
    setSelectedDesktopSourceId,
    refreshDesktopAudioSources,
    desktopChunkCount,
  };
};
