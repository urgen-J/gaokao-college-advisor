/**
 * 带登录态的请求工具 + 按账号隔离的本地缓存 key
 *
 * 说明：
 * - 后端所有会话类接口都要求 Authorization: Bearer <token>，这里统一注入，
 *   避免每个 hook 各写一遍。
 * - 本地缓存（会话模型选择、自定义 Agent 等）也必须按账号分开存，
 *   否则同一台电脑上换个账号登录仍会看到上一个账号的内容。
 */

export const AUTH_TOKEN_KEY = 'gc_auth_token';
export const AUTH_USER_KEY = 'gc_auth_user';

/** 读取当前登录 token（记住我存 localStorage，否则存 sessionStorage） */
export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || sessionStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** 读取当前登录账号名 */
export function getAuthUsername(): string | null {
  try {
    return localStorage.getItem(AUTH_USER_KEY) || sessionStorage.getItem(AUTH_USER_KEY);
  } catch {
    return null;
  }
}

/**
 * 生成账号维度的本地存储 key。
 * 例：scopedKey('sessionModels') -> 'sessionModels::alice'
 * 未登录时退化为 '::guest'，登录后自然与游客数据隔离。
 */
export function scopedKey(base: string): string {
  return `${base}::${getAuthUsername() || 'guest'}`;
}

/** 带 Authorization 头的 fetch */
export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}
