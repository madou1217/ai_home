import { useCallback, useEffect, useRef, useState } from 'react';
import { beginDictationSession } from './dictation-session.js';

interface SpeechRecognitionResultLike {
  readonly [index: number]: { readonly transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export interface UseDictationResult {
  readonly supported: boolean;
  readonly recording: boolean;
  readonly elapsedSeconds: number;
  readonly start: (baseText: string, onTranscript: (mergedText: string) => void) => void;
  readonly stop: () => void;
}

// 只用 SpeechRecognition 做识别；截图里的录音条是纯 CSS 动画，不接音频振幅，
// 没必要再接 getUserMedia/AudioContext——SpeechRecognition.start() 会自己申请麦克风权限。
export function useDictation(): UseDictationResult {
  const [ctor] = useState<SpeechRecognitionCtor | null>(() => getSpeechRecognitionCtor());
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  useEffect(() => () => {
    clearTimer();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
  }, [clearTimer]);

  const start = useCallback((baseText: string, onTranscript: (mergedText: string) => void) => {
    if (!ctor || recognitionRef.current) return;
    beginDictationSession({
      Recognition: ctor,
      baseText,
      onReady: (recognition: SpeechRecognitionLike) => {
        recognitionRef.current = recognition;
      },
      onStart: (recognition: SpeechRecognitionLike) => {
        if (recognitionRef.current !== recognition) return;
        setElapsedSeconds(0);
        setRecording(true);
        clearTimer();
        timerRef.current = setInterval(() => {
          setElapsedSeconds((value) => value + 1);
        }, 1000);
      },
      onTranscript,
      onFinish: (recognition: SpeechRecognitionLike) => {
        if (recognitionRef.current !== recognition) return;
        recognitionRef.current = null;
        clearTimer();
        setRecording(false);
      },
    });
  }, [ctor, clearTimer]);

  return { supported: ctor !== null, recording, elapsedSeconds, start, stop };
}
