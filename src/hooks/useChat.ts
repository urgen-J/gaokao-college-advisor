import { useState, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Message, ToolCall, PermissionRequest, PermissionMode, Session, CustomAgent, ContentBlock } from '../types';
import { authFetch, scopedKey } from '../utils/authFetch';
import { getAppSettings } from './useAppSettings';

// 草稿也按账号隔离，避免换账号后看到别人没发完的输入
const draftInputKey = () => scopedKey('draftInput');

/** 回复结束后按「通用设置」里的偏好做提醒 */
function notifyReplyFinished() {
  try {
    const { notifyOnReply, notifySound } = getAppSettings();

    if (notifyOnReply && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      new Notification('回复已完成', { body: '智愿 AI 已生成回复，点击返回查看' });
    }

    if (notifySound) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.26);
        osc.onended = () => ctx.close().catch(() => {});
      }
    }
  } catch {
    /* 提醒失败不影响主流程 */
  }
}

interface UseChatOptions {
  currentSession: Session | undefined;
  currentSessionId: string | null;
  selectedModel: string;
  getAgent: (id: string) => CustomAgent | undefined;
  addSession: (session: Session) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  updateSessionMessages: (sessionId: string, updater: (messages: Message[]) => Message[]) => void;
  updateSessionModel: (sessionId: string, modelId: string) => void;
  setCurrentSessionId: (id: string | null) => void;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

interface NewChatOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
}

export function useChat(options: UseChatOptions) {
  const {
    currentSession,
    currentSessionId,
    selectedModel,
    getAgent,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [webSearch, setWebSearch] = useState(false); // 联网搜索开关（勾选才走千问联网）
  const [inputValue, setInputValue] = useState(() => {
    return localStorage.getItem(draftInputKey()) || '';
  });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  // 当前正在进行的回答流控制器：用户发新消息/点停止时用来中断上一条
  const abortRef = useRef<AbortController | null>(null);

  // 保存输入框内容到 localStorage（防抖）
  const saveInput = useCallback((value: string) => {
    setInputValue(value);
  }, []);

  // 发送消息
  const sendMessage = useCallback(async (
    messageContent: string,
    newChatOptions?: NewChatOptions,
    onNavigate?: (path: string) => void
  ) => {
    if (!messageContent.trim()) return;

    // 用户在上一条回答还没结束时发了新消息：立刻中断上一条流（终止上个问题的回答）
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    let sessionId = currentSessionId;
    let currentCwd = currentSession?.cwd;
    let currentAgentId = currentSession?.agentId || 'default';
    let currentPermissionMode = currentSession?.permissionMode || 'default';
    
    // 如果没有当前会话，使用新对话页面的选项创建新会话
    if (!sessionId && newChatOptions) {
      const selectedAgent = getAgent(newChatOptions.agentId);
      const agentPermissionMode = selectedAgent?.permissionMode || 'default';
      const finalPermissionMode = newChatOptions.permissionMode !== 'default' 
        ? newChatOptions.permissionMode 
        : agentPermissionMode;
      
      const newSession: Session = {
        id: uuidv4(),
        title: messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : ''),
        model: selectedModel,
        agentId: newChatOptions.agentId,
        cwd: newChatOptions.cwd || undefined,
        permissionMode: finalPermissionMode,
        createdAt: new Date(),
        messages: []
      };
      
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(newSession.id);
      sessionId = newSession.id;
      currentCwd = newSession.cwd;
      currentAgentId = newSession.agentId || 'default';
      currentPermissionMode = newSession.permissionMode || 'default';
      
      updateSessionModel(newSession.id, selectedModel);
      
      onNavigate?.(`/chat/${newSession.id}`);
    }

    const tempUserMessageId = uuidv4();
    const tempAssistantMessageId = uuidv4();
    // 实际落库的助手消息 id（后端 init 事件可能换 id），提升到作用域供 catch/finally 使用
    let realAssistantMessageId = tempAssistantMessageId;

    const userMessage: Message = {
      id: tempUserMessageId,
      role: 'user',
      content: messageContent,
      timestamp: new Date()
    };

    const assistantMessage: Message = {
      id: tempAssistantMessageId,
      role: 'assistant',
      content: '',
      model: selectedModel,
      timestamp: new Date(),
      isStreaming: true,
      contentBlocks: []
    };

    setSessions(prev => prev.map(s => {
      if (s.id === sessionId) {
        const newTitle = s.messages.length === 0 
          ? messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : '')
          : s.title;
        return {
          ...s,
          title: newTitle,
          messages: [...s.messages, userMessage, assistantMessage]
        };
      }
      return s;
    }));

    setInputValue('');
    localStorage.removeItem(draftInputKey());
    setIsLoading(true);

    const agent = getAgent(currentAgentId);
    const systemPrompt = agent?.systemPrompt;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await authFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          message: messageContent,
          model: selectedModel,
          systemPrompt,
          cwd: currentCwd,
          permissionMode: currentPermissionMode,
          webSearch,
        })
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let usedModel = selectedModel;
      let currentToolCalls: ToolCall[] = [];
      let contentBlocks: ContentBlock[] = [];
      let currentTextBlock: string = '';  // 当前正在积累的文本块
      let realSessionId: string = sessionId!;
      realAssistantMessageId = tempAssistantMessageId;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.type === 'init') {
                  realSessionId = data.sessionId;
                  realAssistantMessageId = data.assistantMessageId;
                  usedModel = data.model;
                  
                  if (realSessionId !== sessionId) {
                    setSessions(prev => prev.map(s => 
                      s.id === sessionId ? { ...s, id: realSessionId } : s
                    ));
                    setCurrentSessionId(realSessionId);
                    sessionId = realSessionId;
                  }
                  
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === tempAssistantMessageId 
                            ? { ...m, id: realAssistantMessageId }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'text') {
                  fullContent += data.content;
                  currentTextBlock += data.content;
                  
                  // 更新或创建最后一个文本块
                  const lastBlock = contentBlocks[contentBlocks.length - 1];
                  if (lastBlock && lastBlock.type === 'text') {
                    lastBlock.text = currentTextBlock;
                  } else if (currentTextBlock) {
                    contentBlocks.push({ type: 'text', text: currentTextBlock });
                  }
                  
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === realAssistantMessageId 
                            ? { ...m, content: fullContent, model: usedModel, toolCalls: [...currentToolCalls], contentBlocks: [...contentBlocks] }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'tool') {
                  // 如果有累积的文本，先结束当前文本块
                  currentTextBlock = '';
                  
                  const toolCall: ToolCall = {
                    id: data.id || uuidv4(),
                    name: data.name,
                    input: data.input,
                    status: 'running'
                  };
                  currentToolCalls.push(toolCall);
                  
                  // 添加工具调用块
                  contentBlocks.push({ type: 'tool_use', toolCall });
                  
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === realAssistantMessageId 
                            ? { ...m, toolCalls: [...currentToolCalls], contentBlocks: [...contentBlocks] }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'tool_result') {
                  const toolId = data.toolId;
                  const toolIndex = toolId 
                    ? currentToolCalls.findIndex(t => t.id === toolId)
                    : currentToolCalls.length - 1;
                  
                  if (toolIndex >= 0) {
                    currentToolCalls[toolIndex].status = data.isError ? 'error' : 'completed';
                    currentToolCalls[toolIndex].isError = data.isError || false;
                    currentToolCalls[toolIndex].result = typeof data.content === 'string' 
                      ? data.content 
                      : JSON.stringify(data.content);
                    
                    // 同步更新 contentBlocks 中对应的工具调用
                    const blockIndex = contentBlocks.findIndex(
                      b => b.type === 'tool_use' && b.toolCall.id === currentToolCalls[toolIndex].id
                    );
                    if (blockIndex >= 0) {
                      (contentBlocks[blockIndex] as { type: 'tool_use'; toolCall: ToolCall }).toolCall = { ...currentToolCalls[toolIndex] };
                    }
                    
                    setSessions(prev => prev.map(s => {
                      if (s.id === realSessionId) {
                        return {
                          ...s,
                          messages: s.messages.map(m => 
                            m.id === realAssistantMessageId 
                              ? { ...m, toolCalls: [...currentToolCalls], contentBlocks: [...contentBlocks] }
                              : m
                          )
                        };
                      }
                      return s;
                    }));
                  }
                } else if (data.type === 'done') {
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === realAssistantMessageId 
                            ? { ...m, isStreaming: false }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'permission_request') {
                  console.log('[Permission] Request received:', data);
                  setPermissionRequest({
                    requestId: data.requestId,
                    toolUseId: data.toolUseId,
                    toolName: data.toolName,
                    input: data.input,
                    sessionId: data.sessionId,
                    timestamp: data.timestamp
                  });
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
      }
  } catch (error: any) {
    if (controller.signal.aborted) {
      // 主动中断（用户发了新消息 / 点了停止）：保留已生成内容，仅把这条标为已结束
      setSessions(prev => prev.map(s => {
        if (s.id === sessionId) {
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === realAssistantMessageId
                ? { ...m, isStreaming: false }
                : m
            )
          };
        }
        return s;
      }));
    } else {
      console.error('Chat error:', error);
      setSessions(prev => prev.map(s => {
        if (s.id === sessionId) {
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === realAssistantMessageId
                ? { ...m, content: '发生错误，请重试', isStreaming: false }
                : m
            )
          };
        }
        return s;
      }));
    }
  } finally {
    // 只有「当前这条」回答结束时才收尾；被新消息顶掉的上一条不要误改状态
    if (abortRef.current === controller) {
      abortRef.current = null;
      setIsLoading(false);
      if (!controller.signal.aborted) {
        notifyReplyFinished();
      }
    }
  }
  }, [currentSession, currentSessionId, selectedModel, getAgent, updateSessionModel, setCurrentSessionId, setSessions, webSearch]);

  // 处理停止事件：真正中断当前回答流（不只是改状态）
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      setIsLoading(false);
    }
  }, []);

  // 处理权限允许
  const handlePermissionAllow = useCallback(async () => {
    if (!permissionRequest) return;
    
    console.log('[Permission] User allowed:', permissionRequest.requestId);
    
    await authFetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: permissionRequest.requestId,
        behavior: 'allow'
      })
    });
    
    setPermissionRequest(null);
  }, [permissionRequest]);

  // 处理权限拒绝
  const handlePermissionDeny = useCallback(async () => {
    if (!permissionRequest) return;
    
    console.log('[Permission] User denied:', permissionRequest.requestId);
    
    await authFetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: permissionRequest.requestId,
        behavior: 'deny',
        message: '用户拒绝了此操作'
      })
    });
    
    setPermissionRequest(null);
  }, [permissionRequest]);

  return {
    isLoading,
    inputValue,
    setInputValue: saveInput,
    webSearch,
    setWebSearch,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  };
}
