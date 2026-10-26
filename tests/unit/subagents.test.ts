/**
 * tests/unit/subagents.test.ts
 * 对应 src/agents/subagents.ts（B6 多代理的子代理定义）
 * 详见 docs/12-b-需求-ai对话能力.md §B6
 */
import { describe, it, expect } from 'vitest';
import {
  SUB_AGENTS,
  describeSubAgents,
  getSubAgent,
  subAgentTools,
} from '../../src/agents/subagents';
import { renderSharedState, buildSubAgentSystem } from '../../src/agents/engine';
import { getBuiltinTool } from '../../src/tools/builtin/registry';

describe('B6 · 子代理定义', () => {
  it('三个子代理，key 不重名', () => {
    expect(SUB_AGENTS.length).toBeGreaterThanOrEqual(3);
    const keys = SUB_AGENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个子代理都有：名字 / 描述 / 系统提示词 / 至少一个工具', () => {
    for (const agent of SUB_AGENTS) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.systemPrompt.length).toBeGreaterThan(0);
      expect(agent.tools.length).toBeGreaterThan(0);
    }
  });

  it('⚠️ 子代理只拿只读工具 —— 敏感工具必须被剔除', () => {
    // 这是安全底线：子代理不在 HITL 闸门的覆盖范围内，
    // 让它拿着「提交退款」跑 = 开了一条绕过用户确认的后门。
    for (const agent of SUB_AGENTS) {
      const impls = subAgentTools(agent);
      expect(impls.length).toBeGreaterThan(0);
      for (const impl of impls) {
        expect(impl.sensitive, `${agent.key} 拿到了敏感工具 ${impl.key}`).toBe(false);
      }
    }
  });

  it('声明了敏感工具也会被剔除（防御性）', () => {
    const hacked = {
      key: 'hacked',
      name: '坏代理',
      description: 'x',
      systemPrompt: 'x',
      tools: ['submit_refund_request', 'query_order_status'],
      retrieve: false,
    };
    const impls = subAgentTools(hacked);
    expect(impls.map((i) => i.key)).toEqual(['query_order_status']);
  });

  it('每个子代理的工具都真实存在', () => {
    for (const agent of SUB_AGENTS) {
      for (const key of agent.tools) {
        expect(getBuiltinTool(key), `${agent.key} 引用了不存在的工具 ${key}`).toBeDefined();
      }
    }
  });

  it('getSubAgent 按 key 取', () => {
    expect(getSubAgent('order_agent')?.name).toBe('订单代理');
    expect(getSubAgent('nope')).toBeUndefined();
  });

  it('describeSubAgents 列出全部（写进 delegate 工具的描述里）', () => {
    const text = describeSubAgents();
    for (const agent of SUB_AGENTS) {
      expect(text).toContain(agent.key);
    }
  });
});

describe('B6 · 共享状态', () => {
  it('空状态 → 不渲染任何东西', () => {
    expect(renderSharedState({})).toBe('');
  });

  it('有状态 → 渲染成「共享状态」段', () => {
    const text = renderSharedState({ order_agent: '订单是 SO-2026-0001，待发货' });
    expect(text).toContain('共享状态');
    expect(text).toContain('order_agent');
    expect(text).toContain('待发货');
  });

  it('多个子代理的产出都在里面', () => {
    const text = renderSharedState({
      order_agent: 'A 的结论',
      policy_agent: 'B 的结论',
    });
    expect(text).toContain('A 的结论');
    expect(text).toContain('B 的结论');
  });

  it('超长的产出被截断（不能把整个上下文撑爆）', () => {
    const text = renderSharedState({ order_agent: 'x'.repeat(2000) });
    expect(text.length).toBeLessThan(1200);
    expect(text).toContain('…');
  });

  it('buildSubAgentSystem = 角色提示词 + 共享状态', () => {
    const agent = getSubAgent('order_agent')!;
    const system = buildSubAgentSystem(agent, { policy_agent: '7 天无理由' });
    expect(system).toContain(agent.systemPrompt);
    expect(system).toContain('7 天无理由');
  });

  it('非字符串的产出也渲染得出来（JSON 化）', () => {
    const text = renderSharedState({ order_agent: { status: 'ok', items: 3 } });
    expect(text).toContain('"status":"ok"');
  });
});
