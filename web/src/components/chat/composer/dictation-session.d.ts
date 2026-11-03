/** 浏览器 SpeechRecognition 的最小形状：dictation-session.js 只用到这些成员。 */
export interface DictationRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: {
    readonly results: {
      readonly length: number;
      readonly [index: number]: { readonly [index: number]: { readonly transcript: string } };
    };
  }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop?(): void;
  abort?(): void;
}

export interface DictationSessionOptions<R extends DictationRecognition = DictationRecognition> {
  readonly Recognition: new () => R;
  readonly baseText?: string;
  readonly onReady: (recognition: R) => void;
  readonly onStart: (recognition: R) => void;
  readonly onTranscript: (mergedText: string) => void;
  readonly onFinish: (recognition: R) => void;
}

/** 启动一次识别；构造或 start() 失败时返回 null（并已触发 onFinish）。 */
export declare function beginDictationSession<R extends DictationRecognition>(
  options: DictationSessionOptions<R>
): R | null;
