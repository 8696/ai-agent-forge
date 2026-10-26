import { getBuiltinTool, type BuiltinTool } from '../tools/builtin/registry';

/**
 * 子代理定义 —— B6 多代理协作（docs/12-b-需求-ai对话能力.md §B6）
 *
 * ## 监督者模式（Supervisor Pattern）
 *
 * 主 agent 遇到复杂问题时，把子任务**委派**给专业子代理；
 * 子代理查完把结论回灌给主 agent，主 agent 综合作答。
 *
 * ```
 *   用户提问
 *      ↓
 *   主 agent（streamText + 自动工具循环）
 *      ↓  调 delegate_to_agent(agent, task)
 *   ┌──────────────────────────────────┐
 *   │ 子代理（非流式 generateText）      │
 *   │  · 自己的系统提示词（角色定位）    │
 *   │  · 自己的工具集                    │
 *   │  · **共享状态**（别的子代理的产出）│
 *   └──────────────────────────────────┘
 *      ↓  tool result 回灌
 *   主 agent 继续（可以再派一个，或直接作答）
 * ```
 *
 * ## 为什么子代理只给「只读工具」
 *
 * **写操作（退款 / 建工单）留在主 agent 手里** —— 那些要走 HITL 闸门
 * （用户点确认才执行），而 HITL 的闸门是挂在对话链路的工具执行层上的。
 * 子代理是引擎内部跑的独立 LLM 调用，**不在闸门覆盖范围内** ——
 * 让它拿着敏感工具跑，等于开了一条绕过用户确认的后门。
 *
 * 所以这里的工具集**强制只含非敏感实现**（`sensitive === false`）。
 */
export interface SubAgentDefinition {
  /** 稳定的 key —— 模型用它指定派给谁 */
  key: string;
  /** 显示名 */
  name: string;
  /**
   * 给**主 agent** 看的说明 —— 它决定「这个活该派给谁」。
   * 写清楚「什么时候派给它」比写「它是什么」有用。
   */
  description: string;
  /** 子代理自己的系统提示词（角色定位 + 输出要求） */
  systemPrompt: string;
  /** 允许用的内置工具 key */
  tools: string[];
  /** 要不要检索知识库（RAG）—— 政策类代理需要，事实类不需要 */
  retrieve: boolean;
}

/** 三个内置子代理（电商客服场景） */
export const SUB_AGENTS: readonly SubAgentDefinition[] = [
  {
    key: 'order_agent',
    name: '订单代理',
    description:
      '查订单/物流/商品**事实**：订单当前状态、发货与物流轨迹、商品信息。' +
      '当问题涉及「我这单到哪了 / 买了什么 / 什么时候发」时派给它。',
    systemPrompt:
      '你是订单事实查询代理。只回答订单、物流、商品这三类**事实**，不要推测、不要给建议。' +
      '查不到就直说「查不到」，不要编。回答用简洁的事实陈述，控制在 5 句以内。',
    tools: ['query_order_status', 'query_shipping_track', 'query_product_info'],
    retrieve: false,
  },
  {
    key: 'policy_agent',
    name: '政策代理',
    description:
      '查**平台规则与政策**：退货期限、能不能退、运费谁承担、换货规则。' +
      '当问题涉及「能不能退 / 什么条件 / 按什么规则」时派给它。',
    systemPrompt:
      '你是平台政策代理。只依据检索到的**知识库内容**回答政策问题。' +
      '知识库里没有就明确说「知识库里没有这条规则」，不要凭常识编。' +
      '引用具体条款，控制在 8 句以内。',
    tools: ['list_knowledge_documents'],
    retrieve: true,
  },
  {
    key: 'discount_agent',
    name: '优惠代理',
    description:
      '查**优惠与价格**：账户上有哪些券、券的门槛与额度、商品当前价格与优惠后的实付。' +
      '当问题涉及「有什么券 / 满多少减多少 / 实际多少钱」时派给它。',
    systemPrompt:
      '你是优惠与价格代理。只回答券、门槛、额度、实付金额这几类事实。' +
      '算实付金额时把券的优惠算进去，给出计算过程。控制在 5 句以内。',
    tools: ['query_coupon_info', 'query_product_info'],
    retrieve: false,
  },
];

/** 按 key 取子代理定义 */
export function getSubAgent(key: string): SubAgentDefinition | undefined {
  return SUB_AGENTS.find((a) => a.key === key);
}

/**
 * 取子代理的工具实现 —— **强制只给非敏感工具**。
 *
 * ⚠️ 敏感工具（提交退款 / 建工单）在这里被**静默剔除** ——
 *    子代理不在 HITL 闸门的覆盖范围内，让它拿着敏感工具跑 =
 *    开了一条绕过用户确认的后门。
 */
export function subAgentTools(agent: SubAgentDefinition): BuiltinTool[] {
  const out: BuiltinTool[] = [];
  for (const key of agent.tools) {
    const impl = getBuiltinTool(key);
    if (impl === undefined || impl.sensitive) {
      continue;
    }
    out.push(impl);
  }
  return out;
}

/** 给主 agent 看的「有哪些子代理」清单（写进 delegate 工具的描述里） */
export function describeSubAgents(): string {
  return SUB_AGENTS.map((a) => `- ${a.key}（${a.name}）：${a.description}`).join('\n');
}
