import { useState, FormEvent } from 'react';
import { Input, Button, Checkbox, MessagePlugin } from 'tdesign-react';
import { UserIcon, LockOnIcon, BrowseIcon, BrowseOffIcon } from 'tdesign-icons-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { APP_CONFIG } from '../config';

type AuthMode = 'login' | 'register';

/**
 * 登录 / 注册页（同一张卡片，可在两种模式间切换）
 * - 用户名 / 密码输入框（带图标、错误状态）
 * - 注册模式额外有「确认密码」
 * - 密码可见切换、记住我、忘记密码（仅登录模式）
 * - 表单校验：正常 / 输入中 / 错误提示
 * - 登录（或注册）中 loading 状态 + 成功 / 失败反馈
 * - 移动端与桌面端响应式（卡片居中）
 */
export function LoginPage() {
  // 让登录页也跟随浅色 / 深色主题
  useTheme();

  const { login, register } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // 切换模式：清空表单与错误，避免状态串场
  const switchMode = (next: AuthMode) => {
    if (next === mode) return;
    setMode(next);
    setUsername('');
    setPassword('');
    setConfirm('');
    setUsernameError(null);
    setPasswordError(null);
    setConfirmError(null);
    setFormError(null);
    setLoading(false);
  };

  const handleUsernameChange = (val: string) => {
    setUsername(val);
    if (usernameError) setUsernameError(null);
    if (formError) setFormError(null);
  };

  const handlePasswordChange = (val: string) => {
    setPassword(val);
    if (passwordError) setPasswordError(null);
    if (formError) setFormError(null);
    // 改了密码后，若确认框已填且原先报错，重新比对
    if (confirm && confirmError) setConfirmError(null);
  };

  const handleConfirmChange = (val: string) => {
    setConfirm(val);
    if (confirmError) setConfirmError(null);
    if (formError) setFormError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);

    const uname = username.trim();
    let valid = true;

    // 用户名：必填 + 长度 3-20
    if (!uname) {
      setUsernameError('请输入用户名');
      valid = false;
    } else if (uname.length < 3 || uname.length > 20) {
      setUsernameError('用户名需为 3-20 个字符');
      valid = false;
    }

    // 密码：必填 + 至少 6 位
    if (!password) {
      setPasswordError('请输入密码');
      valid = false;
    } else if (password.length < 6) {
      setPasswordError('密码至少 6 位');
      valid = false;
    }

    // 注册模式：确认密码
    if (mode === 'register') {
      if (!confirm) {
        setConfirmError('请再次输入密码');
        valid = false;
      } else if (confirm !== password) {
        setConfirmError('两次输入的密码不一致');
        valid = false;
      }
    }

    if (!valid) return;

    setLoading(true);
    try {
      const result =
        mode === 'login'
          ? await login(uname, password, remember)
          : await register(uname, password, remember);
      if (result.success) {
        MessagePlugin.success(mode === 'login' ? '登录成功，正在进入…' : '注册成功，正在进入…');
        // 登录态更新后，App 会自动切换到主界面
      } else {
        setFormError(result.message || (mode === 'login' ? '登录失败，请重试' : '注册失败，请重试'));
        MessagePlugin.error(result.message || '操作失败');
      }
    } catch {
      setFormError('网络异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = () => {
    MessagePlugin.info(
      '默认账号：admin / admin123。如需修改密码，请在 .env 中设置 LOGIN_USERNAME 与 LOGIN_PASSWORD 后重启服务。',
    );
  };

  const isLogin = mode === 'login';

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center px-4 py-8 overflow-y-auto"
      style={{
        background:
          'radial-gradient(1200px 600px at 15% 10%, var(--td-brand-color-light), transparent 60%), ' +
          'radial-gradient(1000px 500px at 85% 0%, var(--td-brand-color-light), transparent 55%), ' +
          'var(--td-bg-color-page)',
      }}
    >
      <div
        className="w-full max-w-md p-6 sm:p-8 rounded-2xl"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          boxShadow: 'var(--td-shadow-3)',
          border: '1px solid var(--td-component-stroke)',
        }}
      >
        {/* 品牌头部 */}
        <div className="flex flex-col items-center text-center mb-6">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
            style={{
              background: 'linear-gradient(135deg, var(--td-brand-color), var(--td-brand-color-hover))',
              boxShadow: '0 8px 20px rgba(59, 130, 246, 0.25)',
            }}
          >
            <span className="text-white text-2xl font-bold">{APP_CONFIG.nameInitial}</span>
          </div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            {APP_CONFIG.name}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
            {APP_CONFIG.description}
          </p>
        </div>

        {/* 模式标题 */}
        <h2 className="text-lg font-semibold mb-5" style={{ color: 'var(--td-text-color-primary)' }}>
          {isLogin ? '账号登录' : '注册新账号'}
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          {/* 用户名 */}
          <div className="mb-4">
            <label
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              用户名
            </label>
            <Input
              value={username}
              onChange={handleUsernameChange}
              placeholder="请输入用户名（3-20 个字符）"
              prefixIcon={<UserIcon />}
              status={usernameError ? 'error' : undefined}
              disabled={loading}
              size="large"
              autofocus
              autoComplete="username"
            />
            {usernameError && (
              <p className="mt-1 text-xs" style={{ color: 'var(--td-error-color, #f56c6c)' }}>
                {usernameError}
              </p>
            )}
          </div>

          {/* 密码 */}
          <div className="mb-4">
            <label
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              密码
            </label>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={handlePasswordChange}
              placeholder="请输入密码（至少 6 位）"
              prefixIcon={<LockOnIcon />}
              suffixIcon={
                <span
                  onClick={() => !loading && setShowPassword((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    cursor: loading ? 'not-allowed' : 'pointer',
                    color: 'var(--td-text-color-secondary)',
                    display: 'inline-flex',
                  }}
                  aria-label="切换密码可见"
                >
                  {showPassword ? <BrowseOffIcon /> : <BrowseIcon />}
                </span>
              }
              status={passwordError ? 'error' : undefined}
              disabled={loading}
              size="large"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              onEnter={handleSubmit}
            />
            {passwordError && (
              <p className="mt-1 text-xs" style={{ color: 'var(--td-error-color, #f56c6c)' }}>
                {passwordError}
              </p>
            )}
          </div>

          {/* 确认密码（仅注册模式） */}
          {!isLogin && (
            <div className="mb-4">
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                确认密码
              </label>
              <Input
                type={showPassword ? 'text' : 'password'}
                value={confirm}
                onChange={handleConfirmChange}
                placeholder="请再次输入密码"
                prefixIcon={<LockOnIcon />}
                status={confirmError ? 'error' : undefined}
                disabled={loading}
                size="large"
                autoComplete="new-password"
                onEnter={handleSubmit}
              />
              {confirmError && (
                <p className="mt-1 text-xs" style={{ color: 'var(--td-error-color, #f56c6c)' }}>
                  {confirmError}
                </p>
              )}
            </div>
          )}

          {/* 记住我 + 忘记密码（仅登录模式） */}
          {isLogin && (
            <div className="flex items-center justify-between mb-5">
              <Checkbox checked={remember} onChange={(v) => setRemember(Boolean(v))}>
                记住我
              </Checkbox>
              <Button
                variant="text"
                size="small"
                onClick={handleForgot}
                style={{ padding: 0, color: 'var(--td-brand-color)', height: 'auto' }}
              >
                忘记密码？
              </Button>
            </div>
          )}

          {/* 全局错误提示 */}
          {formError && (
            <div
              className="mb-4 px-3 py-2 rounded-lg text-sm"
              style={{
                backgroundColor: 'var(--td-error-color-light, rgba(245, 108, 108, 0.12))',
                color: 'var(--td-error-color, #f56c6c)',
              }}
            >
              {formError}
            </div>
          )}

          {/* 提交按钮 */}
          <Button type="submit" theme="primary" block size="large" loading={loading} disabled={loading}>
            {loading ? (isLogin ? '登录中…' : '注册中…') : isLogin ? '登录' : '注册'}
          </Button>
        </form>

        {/* 模式切换 */}
        <p className="mt-6 text-center text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          {isLogin ? '还没有账号？' : '已有账号？'}
          <button
            type="button"
            onClick={() => switchMode(isLogin ? 'register' : 'login')}
            className="ml-1 font-medium hover:underline"
            style={{ color: 'var(--td-brand-color)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {isLogin ? '立即注册' : '去登录'}
          </button>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
