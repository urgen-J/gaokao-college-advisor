import { Button, Tooltip } from 'tdesign-react';
import { 
  RefreshIcon,
  SunnyIcon,
  MoonIcon,
  MenuFoldIcon,
  MenuUnfoldIcon,
  AddIcon,
} from 'tdesign-icons-react';
import { Bot } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Model, Session, Agent, Theme } from '../types';
import { ICON_MAP } from '../utils/iconMap';

interface HeaderProps {
  isSettingsPage: boolean;
  sidebarOpen: boolean;
  theme: Theme;
  currentSession: Session | undefined;
  currentAgent: Agent | undefined;
  models: Model[];
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onRefreshModels: () => void;
  onNewChat: () => void;
}

export function Header({
  isSettingsPage,
  sidebarOpen,
  theme,
  currentSession,
  currentAgent,
  onToggleSidebar,
  onToggleTheme,
  onRefreshModels,
  onNewChat,
}: HeaderProps) {
  return (
    <header 
      className="h-14 flex justify-between items-center px-4 flex-shrink-0"
      style={{ 
        backgroundColor: 'var(--td-bg-color-page)'
      }}
    >
      <div className="flex items-center gap-3">
        {!sidebarOpen && (
          <img
            src="/logo-icon.png"
            alt="智愿 AI"
            className="h-[60px] w-auto object-contain"
          />
        )}
        <div 
          className="flex items-center gap-1 p-0.5 rounded-2xl"
          style={{ border: '1px solid var(--td-component-border)' }}
        >
          <Tooltip content={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
            <Button
              variant="text"
              shape="circle"
              icon={sidebarOpen ? <MenuFoldIcon /> : <MenuUnfoldIcon />}
              onClick={onToggleSidebar}
            />
          </Tooltip>
          <Tooltip content="开启新对话">
            <Button
              variant="text"
              shape="circle"
              icon={<AddIcon />}
              onClick={onNewChat}
              aria-label="开启新对话"
            />
          </Tooltip>
        </div>
        <h1
          className="text-base font-semibold"
          style={{ color: 'var(--td-text-color-primary)' }}
        >
          {isSettingsPage ? '设置' : (currentSession?.title || '')}
        </h1>
      </div>
      <div className="flex items-center gap-2">
        <Tooltip content={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}>
          <Button
            variant="outline"
            shape="circle"
            icon={theme === 'light' ? <MoonIcon /> : <SunnyIcon />}
            onClick={onToggleTheme}
          />
        </Tooltip>
        {!isSettingsPage && (
          <Tooltip content="刷新模型列表">
            <Button
              variant="outline"
              shape="circle"
              icon={<RefreshIcon />}
              onClick={onRefreshModels}
            />
          </Tooltip>
        )}
      </div>
    </header>
  );
}
