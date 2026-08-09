import { useState, useEffect, useCallback } from 'react';
import { CustomAgent } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { scopedKey } from '../utils/authFetch';

// 自定义 Agent 按登录账号隔离存储
const storageKey = () => scopedKey('customAgents');

// 默认的 Agent
const DEFAULT_AGENT: CustomAgent = {
  id: 'default',
  name: '智愿 AI',
  description: '为高考后的学生提供院校选择、专业推荐和志愿填报策略指导',
  systemPrompt: `你是一位资深的高考志愿填报指导专家，专门帮助高考后的学生和家长做出科学的院校选择。

你的职责：
1. 【信息收集】先了解学生的关键信息：省份、科类（文/理/新高考选科）、高考分数、省内排名（位次）、兴趣方向、职业倾向、家庭预算、地域偏好等。信息不全时，一次只追问一两个最关键的问题。
2. 【选校策略】基于"冲稳保"梯度原则给出院校建议：冲刺档（录取位次略高于学生）、稳妥档（位次匹配）、保底档（位次留有余量），并说明每档的推荐理由和风险。
3. 【专业指导】结合学生兴趣、就业前景、学科实力（学科评估、双一流建设情况）分析专业选择，提醒专业级差、调剂风险、body（体检）限制、单科成绩要求等注意事项。
4. 【规则讲解】用通俗易懂的语言解释平行志愿、投档规则、退档风险、提前批、专项计划等政策概念。
5. 【理性建议】客观呈现选项的利弊（如"城市 vs 学校 vs 专业"的权衡），不替学生做最终决定，尊重学生本人意愿。

注意事项：
- 历年分数线和位次数据可能有变化，提醒学生以省考试院和高校官网发布的最新数据为准。
- 涉及具体分数预测时，说明这只是基于历史数据的参考，不构成录取保证。
- 语气亲切耐心，像一位负责任的学长/老师，避免制造焦虑。
- 回答结构清晰，善用列表和分档呈现建议。`,
  icon: 'Bot',
  color: '#0052d9',
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function useAgents() {
  const [agents, setAgents] = useState<CustomAgent[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey());
      if (saved) {
        const parsed = JSON.parse(saved);
        return [DEFAULT_AGENT, ...parsed.map((a: any) => ({
          ...a,
          createdAt: new Date(a.createdAt),
          updatedAt: new Date(a.updatedAt),
        }))];
      }
    } catch (e) {
      console.error('Failed to load agents:', e);
    }
    return [DEFAULT_AGENT];
  });

  // 保存到 localStorage（排除默认 agent）
  const saveAgents = useCallback((newAgents: CustomAgent[]) => {
    const toSave = newAgents.filter(a => a.id !== 'default');
    localStorage.setItem(storageKey(), JSON.stringify(toSave));
  }, []);

  const addAgent = useCallback((agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newAgent: CustomAgent = {
      ...agent,
      id: uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setAgents(prev => {
      const updated = [...prev, newAgent];
      saveAgents(updated);
      return updated;
    });
    return newAgent;
  }, [saveAgents]);

  const updateAgent = useCallback((id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => {
    setAgents(prev => {
      const updated = prev.map(a => 
        a.id === id ? { ...a, ...updates, updatedAt: new Date() } : a
      );
      saveAgents(updated);
      return updated;
    });
  }, [saveAgents]);

  const deleteAgent = useCallback((id: string) => {
    if (id === 'default') return; // 不能删除默认 agent
    setAgents(prev => {
      const updated = prev.filter(a => a.id !== id);
      saveAgents(updated);
      return updated;
    });
  }, [saveAgents]);

  const getAgent = useCallback((id: string) => {
    return agents.find(a => a.id === id);
  }, [agents]);

  return {
    agents,
    addAgent,
    updateAgent,
    deleteAgent,
    getAgent,
    defaultAgent: DEFAULT_AGENT,
  };
}
