import { useState, useEffect, useCallback, useRef } from 'react';

type CaptureInputSource = 'microphone' | 'system_audio';
type PipelineAudioFormat = 'wav' | 'pcm16' | 'webm_opus';

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

export const useSpeechRecognition = (): UseSpeechRecognitionReturn => {
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
      const response = await fetch(`${baseUrl}/pipeline/transcribe-analyze`, {
        method: 'POST',
        body: form,
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
      const message = error instanceof Error ? error.message : String(error);
      notifyPipelineError(message);
      resetPipelineSession();
    }
  }, [applyPipelineTranscript, notifyPipelineError, resetPipelineSession]);

  const enqueuePipelineChunk = useCallback((chunk: DesktopAudioChunk, options: PipelineSendOptions = {}) => {
    if (!backendBaseUrlRef.current) return;
    pipelineQueueRef.current = pipelineQueueRef.current
      .then(() => sendPipelineChunk(chunk, options))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        notifyPipelineError(message);
      });
  }, [notifyPipelineError, sendPipelineChunk]);

  const flushPipelineFinalChunk = useCallback(async () => {
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

    const offChunk = window.desktopAPI?.onAudioChunk((chunk) => {
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
      void window.desktopAPI?.stopAudioCapture?.();
    };
  }, [enqueuePipelineChunk, refreshDesktopAudioSources, stopBrowserRecognition]);

  const startListening = useCallback(async (): Promise<StartListeningResult> => {
    if (isStartingRef.current || listeningRef.current) {
      return { ok: false, mode: 'none', message: 'すでに開始中です。' };
    }

    isStartingRef.current = true;
    setError(null);
    setDesktopChunkCount(0);
    resetPipelineSession();

    try {
      if (inputSource === 'system_audio') {
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
  }, [inputSource, isDesktopCaptureAvailable, resetPipelineSession, selectedDesktopSourceId, startBrowserRecognition]);

  const stopListening = useCallback(async () => {
    listeningRef.current = false;
    setIsListening(false);
    stopBrowserRecognition();
    if (window.desktopAPI?.stopAudioCapture) {
      await window.desktopAPI.stopAudioCapture();
    }
    await flushPipelineFinalChunk();
  }, [flushPipelineFinalChunk, stopBrowserRecognition]);

  const resetTranscript = useCallback(() => {
    browserTranscriptRef.current = '';
    resetPipelineSession();
    setTranscript('');
  }, [resetPipelineSession]);

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
