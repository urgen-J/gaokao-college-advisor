import { useState, useCallback, useEffect } from 'react';
import { scopedKey } from '../utils/authFetch';

/**
 * 应用通用设置（通知偏好、语言、发送快捷键等）
 * 按登录账号隔离存储，换账号不会继承上一个账号的偏好。
 */

export type AppLanguage = 'zh-CN' | 'en-US';

export interface AppSettings {
  /** 回复完成后，页面在后台时弹系统通知 */
  notifyOnReply: boolean;
  /** 回复完成提示音 */
  notifySound: boolean;
  /** 界面语言 */
  language: AppLanguage;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  notifyOnReply: false,
  notifySound: false,
  language: 'zh-CN',
};

const settingsKey = () => scopedKey('appSettings');

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(settingsKey());
    if (raw) return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 解析失败按默认值处理 */
  }
  return { ...DEFAULT_APP_SETTINGS };
}

/** 供非 React 环境（如 useChat 内部）读取当前设置 */
export function getAppSettings(): AppSettings {
  return readSettings();
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(readSettings);

  useEffect(() => {
    try {
      localStorage.setItem(settingsKey(), JSON.stringify(settings));
    } catch {
      /* ignore quota errors */
    }
  }, [settings]);

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const resetSettings = useCallback(() => {
    setSettings({ ...DEFAULT_APP_SETTINGS });
  }, []);

  return { settings, updateSetting, resetSettings };
}
