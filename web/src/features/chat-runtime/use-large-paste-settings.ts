import { useCallback, useEffect, useState } from 'react';
import { chatPasteSettingsAPI, type ChatPasteSettings } from '@/services/api';
import {
  CHAT_ATTACHMENT_LIMITS,
  largePasteCharLimit,
  setLargePasteCharLimit,
} from '@/components/chat/attachment-files';

const listeners = new Set<(value: number) => void>();
let loaded: Promise<void> | null = null;

function publish(value: number): void {
  setLargePasteCharLimit(value);
  const effective = largePasteCharLimit();
  listeners.forEach((listener) => listener(effective));
}

/** 进入会话页时拉一次 Server 配置；失败就保持默认（粘贴照常可用）。 */
export function ensureLargePasteSettingsLoaded(): Promise<void> {
  if (!loaded) {
    loaded = chatPasteSettingsAPI.get()
      .then((settings) => publish(settings.largePasteChars))
      .catch(() => { loaded = null; });
  }
  return loaded;
}

/**
 * 设置页用：读取/修改当前 Server 的粘贴阈值。修改成功后立即作用于本页所有输入框。
 */
export function useLargePasteSettings() {
  const [value, setValue] = useState(largePasteCharLimit());
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const listener = (next: number) => setValue(next);
    listeners.add(listener);
    void chatPasteSettingsAPI.get()
      .then((settings) => { setCustom(settings.custom); publish(settings.largePasteChars); })
      .catch(() => {});
    return () => { listeners.delete(listener); };
  }, []);
  const save = useCallback(async (next: number | null): Promise<ChatPasteSettings> => {
    setSaving(true);
    try {
      const settings = await chatPasteSettingsAPI.set(next);
      setCustom(settings.custom);
      publish(settings.largePasteChars);
      return settings;
    } finally {
      setSaving(false);
    }
  }, []);
  return { value, custom, saving, save, limits: CHAT_ATTACHMENT_LIMITS.largePasteChars };
}
