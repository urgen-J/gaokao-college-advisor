import { useState } from 'react';
import {
  Button,
  Popconfirm,
  MessagePlugin,
  Radio,
  Switch,
  Select,
  Tag,
  Input,
} from 'tdesign-react';
import {
  LogoutIcon,
  UserIcon,
  DeleteIcon,
  SettingIcon,
  ErrorCircleIcon,
} from 'tdesign-icons-react';
import { Theme } from '../types';
import { useAuth } from '../context/AuthContext';
import { useAppSettings, AppLanguage } from '../hooks/useAppSettings';

interface SettingsPageProps {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

/** 分区外壳：统一卡片样式 */
function Section({
  title,
  desc,
  icon,
  children,
}: {
  title: string;
  desc?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-2xl border p-5 sm:p-6"
      style={{
        backgroundColor: 'var(--td-bg-color-container)',
        borderColor: 'var(--td-component-stroke)',
        boxShadow: 'var(--td-shadow-1)',
      }}
    >
      <div className="flex items-start gap-3 mb-5">
        {icon && (
          <div
            className="flex items-center justify-center w-9 h-9 rounded-xl shrink-0"
            style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
          >
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            {title}
          </h2>
          {desc && (
            <p className="text-xs mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {desc}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

/** 单行设置项：左边标题+说明，右边控件 */
function SettingRow({
  label,
  hint,
  children,
  danger,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-4 border-b last:border-b-0"
      style={{ borderColor: 'var(--td-component-stroke)' }}
    >
      <div className="min-w-0 sm:pr-6">
        <div
          className="text-sm font-medium"
          style={{ color: danger ? 'var(--td-error-color, #d54941)' : 'var(--td-text-color-primary)' }}
        >
          {label}
        </div>
        {hint && (
          <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage({ theme, onThemeChange }: SettingsPageProps) {
  const { username, logout, deleteAccount } = useAuth();
  const { settings, updateSetting } = useAppSettings();

  const [deleting, setDeleting] = useState(false);
  // 二次确认：需要手动输入用户名才允许注销，防止手滑
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const confirmMatched = confirmText.trim() === (username || '');

  // 开启系统通知时主动申请浏览器权限
  const handleNotifyChange = async (value: boolean) => {
    if (value && typeof Notification !== 'undefined') {
      if (Notification.permission === 'denied') {
        MessagePlugin.warning('浏览器已禁止本站通知，请先在浏览器设置里放开权限');
        return;
      }
      if (Notification.permission !== 'granted') {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          MessagePlugin.warning('未获得通知权限，开关未生效');
          return;
        }
      }
    }
    updateSetting('notifyOnReply', value);
  };

  const handleLogout = () => {
    logout();
    MessagePlugin.success('已退出登录');
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    const res = await deleteAccount();
    setDeleting(false);
    if (res.success) {
      MessagePlugin.success(res.message || '账号已注销');
      setConfirmVisible(false);
      setConfirmText('');
      // deleteAccount 内部已清除登录态，界面会自动回到登录页
    } else {
      MessagePlugin.error(res.message || '注销失败，请重试');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        {/* ===== 通用设置 ===== */}
        <Section
          title="通用设置"
          desc="外观、通知与语言等应用基础配置，仅对当前账号生效"
          icon={<SettingIcon size="20px" />}
        >
          <SettingRow label="主题外观" hint="切换浅色 / 深色界面">
            <Radio.Group
              variant="default-filled"
              value={theme}
              onChange={(v) => onThemeChange(v as Theme)}
            >
              <Radio.Button value="light">浅色</Radio.Button>
              <Radio.Button value="dark">深色</Radio.Button>
            </Radio.Group>
          </SettingRow>

          <SettingRow
            label="回复完成通知"
            hint="页面切到后台时，AI 回复完成后弹出系统通知（需浏览器授权）"
          >
            <Switch value={settings.notifyOnReply} onChange={(v) => handleNotifyChange(!!v)} />
          </SettingRow>

          <SettingRow label="提示音" hint="回复完成时播放一声轻提示音">
            <Switch
              value={settings.notifySound}
              onChange={(v) => updateSetting('notifySound', !!v)}
            />
          </SettingRow>

          <SettingRow label="界面语言" hint="目前仅提供简体中文，英文界面正在开发中">
            <Select
              style={{ width: 170 }}
              value={settings.language}
              onChange={(v) => updateSetting('language', v as AppLanguage)}
              options={[
                { label: '简体中文', value: 'zh-CN' },
                { label: 'English（即将支持）', value: 'en-US', disabled: true },
              ]}
            />
          </SettingRow>
        </Section>

        {/* ===== 账号管理 ===== */}
        <Section
          title="账号管理"
          desc="当前登录账号的退出与注销操作"
          icon={<UserIcon size="20px" />}
        >
          <SettingRow label="当前账号" hint="每个账号的会话与设置相互独立，互不可见">
            <Tag theme="primary" variant="light-outline" size="medium">
              {username || '未知账号'}
            </Tag>
          </SettingRow>

          <SettingRow label="退出登录" hint="退出后返回登录页面，本地会话数据仍会保留">
            <Popconfirm
              content="确定要退出登录吗？"
              confirmBtn={{ content: '退出登录', theme: 'primary' }}
              cancelBtn="取消"
              onConfirm={handleLogout}
            >
              <Button theme="default" variant="outline" icon={<LogoutIcon />}>
                退出登录
              </Button>
            </Popconfirm>
          </SettingRow>

          <SettingRow
            danger
            label="注销账号"
            hint="将永久删除该账号及其名下全部会话记录，操作不可恢复"
          >
            <Button
              theme="danger"
              variant="outline"
              icon={<DeleteIcon />}
              onClick={() => {
                setConfirmText('');
                setConfirmVisible(true);
              }}
            >
              注销账号
            </Button>
          </SettingRow>

          {/* 二次确认区（点了「注销账号」才展开） */}
          {confirmVisible && (
            <div
              className="mt-4 rounded-xl border p-4"
              style={{
                borderColor: 'var(--td-error-color-3, #f5b8b4)',
                backgroundColor: 'var(--td-error-color-1, rgba(213,73,65,0.08))',
              }}
            >
              <div className="flex items-start gap-2 mb-3">
                <ErrorCircleIcon
                  size="18px"
                  style={{ color: 'var(--td-error-color, #d54941)', marginTop: 2, flexShrink: 0 }}
                />
                <div className="text-sm leading-relaxed" style={{ color: 'var(--td-text-color-primary)' }}>
                  <div className="font-medium mb-1">此操作不可撤销</div>
                  <div style={{ color: 'var(--td-text-color-secondary)' }}>
                    注销后，账号
                    <span className="font-medium mx-1" style={{ color: 'var(--td-error-color, #d54941)' }}>
                      {username}
                    </span>
                    及其全部对话记录将被永久删除，无法找回。
                    请输入用户名以确认。
                  </div>
                </div>
              </div>

              <Input
                value={confirmText}
                onChange={(v) => setConfirmText(String(v))}
                placeholder={`请输入 ${username || ''} 以确认`}
                status={confirmText && !confirmMatched ? 'error' : undefined}
                tips={confirmText && !confirmMatched ? '用户名不一致' : undefined}
                autofocus
              />

              <div className="flex items-center gap-2 mt-3">
                <Button
                  theme="danger"
                  loading={deleting}
                  disabled={!confirmMatched}
                  onClick={handleDeleteAccount}
                >
                  确认注销
                </Button>
                <Button
                  theme="default"
                  variant="text"
                  disabled={deleting}
                  onClick={() => {
                    setConfirmVisible(false);
                    setConfirmText('');
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

export default SettingsPage;
