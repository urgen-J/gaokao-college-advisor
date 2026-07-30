import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';

/**
 * 登录鉴权上下文
 * - 登录态存于 localStorage（记住我）或 sessionStorage（不记住，关标签页即失效）
 * - 启动时向后端 /api/auth/me 校验 token 是否仍然有效
 */

const TOKEN_KEY = 'gc_auth_token';
const USER_KEY = 'gc_auth_user';

interface LoginResult {
  success: boolean;
  message?: string;
}

/** 清掉当前账号在本地留下的缓存（会话模型选择、自定义 Agent、草稿等） */
function clearScopedCache(name: string | null) {
  if (!name) return;
  const suffix = `::${name}`;
  try {
    for (const store of [localStorage, sessionStorage]) {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.endsWith(suffix)) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
    }
  } catch {
    /* ignore */
  }
}

interface AuthContextValue {
  isAuthenticated: boolean;
  username: string | null;
  token: string | null;
  /** 启动时正在校验登录态 */
  checking: boolean;
  login: (username: string, password: string, remember: boolean) => Promise<LoginResult>;
  register: (username: string, password: string, remember: boolean) => Promise<LoginResult>;
  logout: () => void;
  /** 注销账号：删除账号及其全部数据，随后自动退出到登录页 */
  deleteAccount: () => Promise<LoginResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function getStored(key: string): string | null {
  try {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStored(key: string, value: string, remember: boolean) {
  const store = remember ? localStorage : sessionStorage;
  try {
    store.setItem(key, value);
  } catch {
    /* ignore quota / privacy errors */
  }
}

function clearStored(key: string) {
  try {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // 启动时从本地存储恢复登录态，并向后端校验 token 是否有效
  useEffect(() => {
    let active = true;
    const storedToken = getStored(TOKEN_KEY);
    const storedUser = getStored(USER_KEY);

    if (!storedToken) {
      setChecking(false);
      return;
    }

    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d?.success && d?.authenticated) {
          setToken(storedToken);
          setUsername(storedUser || d.username || null);
        } else {
          clearStored(TOKEN_KEY);
          clearStored(USER_KEY);
        }
      })
      .catch(() => {
        if (!active) return;
        clearStored(TOKEN_KEY);
        clearStored(USER_KEY);
      })
      .finally(() => {
        if (active) setChecking(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(
    async (u: string, p: string, remember: boolean): Promise<LoginResult> => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p }),
        });
        const data = await res.json();
        if (data?.success && data?.token) {
          setToken(data.token);
          setUsername(data.username || u);
          setStored(TOKEN_KEY, data.token, remember);
          setStored(USER_KEY, data.username || u, remember);
          return { success: true };
        }
        return { success: false, message: data?.message || '登录失败，请重试' };
      } catch {
        return { success: false, message: '网络异常，请稍后重试' };
      }
    },
    [],
  );

  const register = useCallback(
    async (u: string, p: string, remember: boolean): Promise<LoginResult> => {
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p }),
        });
        const data = await res.json();
        if (data?.success && data?.token) {
          setToken(data.token);
          setUsername(data.username || u);
          setStored(TOKEN_KEY, data.token, remember);
          setStored(USER_KEY, data.username || u, remember);
          return { success: true };
        }
        return { success: false, message: data?.message || '注册失败，请重试' };
      } catch {
        return { success: false, message: '网络异常，请稍后重试' };
      }
    },
    [],
  );

  const logout = useCallback(() => {
    const current = getStored(TOKEN_KEY);
    if (current) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${current}` },
      }).catch(() => {
        /* ignore network error on logout */
      });
    }
    setToken(null);
    setUsername(null);
    clearStored(TOKEN_KEY);
    clearStored(USER_KEY);
  }, []);

  const deleteAccount = useCallback(async (): Promise<LoginResult> => {
    const current = getStored(TOKEN_KEY);
    const name = getStored(USER_KEY);
    if (!current) {
      return { success: false, message: '登录状态已失效，请重新登录' };
    }
    try {
      const res = await fetch('/api/auth/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${current}` },
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        return { success: false, message: data?.message || '注销账号失败，请重试' };
      }
      // 后端已删数据并作废 token，这里清干净本地缓存并回到登录页
      clearScopedCache(name);
      setToken(null);
      setUsername(null);
      clearStored(TOKEN_KEY);
      clearStored(USER_KEY);
      return { success: true, message: data?.message };
    } catch {
      return { success: false, message: '网络异常，请稍后重试' };
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        username,
        token,
        checking,
        login,
        register,
        logout,
        deleteAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内部使用');
  }
  return ctx;
}
