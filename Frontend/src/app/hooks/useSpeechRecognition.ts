import { useState, useEffect, useCallback, useRef } from 'react';

type CaptureInputSource = 'microphone' | 'system_audio';
type StartListeningResult = {
  ok: boolean;
  mode: 'browser' | 'desktop' | 'hybrid' | 'none';
  message?: string;
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

  useEffect(() => {
    inputSourceRef.current = inputSource;
  }, [inputSource]);

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

    const offChunk = window.desktopAPI?.onAudioChunk(() => {
      setDesktopChunkCount((current) => current + 1);
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
  }, [refreshDesktopAudioSources, stopBrowserRecognition]);

  const startListening = useCallback(async (): Promise<StartListeningResult> => {
    if (isStartingRef.current || listeningRef.current) {
      return { ok: false, mode: 'none', message: 'すでに開始中です。' };
    }

    isStartingRef.current = true;
    setError(null);
    setDesktopChunkCount(0);

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
        return {
          ok: true,
          mode: 'desktop',
          message: 'システム音声は現在チャンク取得のみです。文字起こし連携は次段で実装予定です。',
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
  }, [inputSource, isDesktopCaptureAvailable, selectedDesktopSourceId, startBrowserRecognition]);

  const stopListening = useCallback(async () => {
    listeningRef.current = false;
    setIsListening(false);
    stopBrowserRecognition();
    if (window.desktopAPI?.stopAudioCapture) {
      await window.desktopAPI.stopAudioCapture();
    }
  }, [stopBrowserRecognition]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
  }, []);

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
