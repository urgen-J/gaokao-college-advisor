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
            className="inline-block scale-[1.8] origin-top transition-transform duration-300 ease-out"
          >
            <h2 
              className="text-2xl font-semibold mb-2"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {APP_CONFIG.name}
            </h2>
            <p className="scale-[0.5556] origin-center" style={{ color: 'var(--td-text-color-secondary)' }}>
              有什么可以帮你的？
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
