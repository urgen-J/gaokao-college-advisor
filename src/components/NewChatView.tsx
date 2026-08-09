import { APP_CONFIG } from '../config';
import { Model, Agent, PermissionMode } from '../types';

interface NewChatViewProps {
  agents: Agent[];
  models: Model[];
  selectedModel: string;
  newChatAgentId: string;
  newChatCwd: string;
  newChatPermissionMode: PermissionMode;
  onSelectModel: (modelId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSetCwd: (cwd: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
}

export function NewChatView({}: NewChatViewProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="w-full max-w-lg">
        {/* 标题 */}
        <div className="text-center mb-8 -mt-32">
          <div
            className="inline-block scale-[1.6] origin-top transition-transform duration-300 ease-out"
          >
            <h2
              className="text-3xl font-bold mb-2"
              style={{ color: 'var(--td-brand-color)' }}
            >
              智愿 AI
            </h2>
            <p className="scale-[0.625] origin-center text-base mb-1" style={{ color: 'var(--td-text-color-secondary)' }}>
              你的智能高考志愿填报助手
            </p>
            <p className="scale-[0.625] origin-center text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
              有什么可以帮您的？
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
