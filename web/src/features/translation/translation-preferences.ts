// 划词翻译的开关（全局悬浮窗）。
//
// 悬浮窗是「选中文本就冒出来」的交互，必须能被永久关掉：有些页面（日志、代码）
// 选区操作很频繁，弹层反而碍事。开关存 localStorage，页面顶栏与快捷键都能切，
// 组件通过订阅保持同步。

export interface TranslationFloatingPreferences {
  enabled: boolean;
}

const STORAGE_KEY = 'aih.translation.floating';
export const DEFAULT_TRANSLATION_FLOATING_PREFERENCES: TranslationFloatingPreferences = {
  enabled: true,
};

type Listener = (preferences: TranslationFloatingPreferences) => void;

const listeners = new Set<Listener>();

function normalize(raw: unknown): TranslationFloatingPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TRANSLATION_FLOATING_PREFERENCES };
  const record = raw as Record<string, unknown>;
  return {
    // 只认显式 false：旧版本写入的坏值不应把功能永久关掉。
    enabled: record.enabled === false ? false : true,
  };
}

function read(): TranslationFloatingPreferences {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_TRANSLATION_FLOATING_PREFERENCES };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRANSLATION_FLOATING_PREFERENCES };
    return normalize(JSON.parse(raw));
  } catch (_error) {
    return { ...DEFAULT_TRANSLATION_FLOATING_PREFERENCES };
  }
}

let cached: TranslationFloatingPreferences = read();

export function getTranslationFloatingPreferences(): TranslationFloatingPreferences {
  return cached;
}

export function setTranslationFloatingPreferences(
  patch: Partial<TranslationFloatingPreferences>,
): TranslationFloatingPreferences {
  cached = normalize({ ...cached, ...patch });
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    } catch (_error) {
      // 隐私模式下写不进去时仍然保持本次会话内生效。
    }
  }
  for (const listener of listeners) {
    try {
      listener(cached);
    } catch (_error) {
      // 单个订阅者异常不影响其它订阅者。
    }
  }
  return cached;
}

export function toggleTranslationFloating(): TranslationFloatingPreferences {
  return setTranslationFloatingPreferences({ enabled: !cached.enabled });
}

export function subscribeTranslationFloatingPreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：把模块级缓存清回默认值。 */
export function resetTranslationFloatingPreferencesForTests() {
  cached = { ...DEFAULT_TRANSLATION_FLOATING_PREFERENCES };
  listeners.clear();
}
