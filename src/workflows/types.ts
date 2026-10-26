/**
 * 工作流（流程）定义 —— B5 状态机工作流
 *
 * 详见 docs/12-b-需求-ai对话能力.md §B5.1（三条电商流程的状态图）。
 *
 * ## 为什么流程定义要独立成一层
 *
 * 流程是**数据**，不是代码逻辑：
 *  - 哪些工具属于这条流程、每个工具前面要先做什么、哪一步要用户点头
 *  - 这些东西写在定义里，引擎（`engine.ts`）只管按定义执行
 *
 * 这样加一条流程 = 加一条定义，**不改引擎**。
 *
 * ## 节点与工具的关系
 *
 * 一个流程由若干**节点**组成，节点 ↔ 内置工具是一对一（或一对多）关系。
 * 节点的 `requires` 写的是**节点 id**（不是工具 key）——
 * 节点 id 是流程内部的名字，工具 key 是全局的实现名，两者的关系由定义这层决定。
 *
 * ## 入口（trigger）
 *
 * 每条流程有一个**唯一**的触发工具 —— 模型调它 = 想发起这条流程。
 * 触发工具一定是 `confirm: true` 的节点（发起流程本身就是要人点头的动作）。
 *
 * ⚠️ **触发工具必须全局唯一**：读步骤的工具（`query_order_status`）被三条流程共用，
 *   它们不能当触发器 —— 否则「查订单」到底属于哪条流程就说不清了。
 */
export interface WorkflowNode {
  /** 节点 id —— 流程内部的名字，写进 `missions.current_step` */
  id: string;
  /** 该节点执行的内置工具 key（对应 `src/tools/builtin/registry.ts`） */
  tool: string;
  /** 是否需要人工确认。true 时流程会停在 `awaiting_confirmation` 等用户点头 */
  confirm: boolean;
  /** 前置节点 id —— 全部完成后本节点才能执行 */
  requires: string[];
  /** 一句话说明这个节点在干什么（给模型看，也给日志看） */
  title: string;
}

export interface WorkflowDefinition {
  /** 流程类型 —— 写进 `missions.type` */
  type: string;
  /** 流程名（后台 / 日志里看） */
  title: string;
  /** 触发工具 key —— 模型调它 = 想发起这条流程 */
  trigger: string;
  /** 节点表（顺序不重要，引擎按 `requires` 推） */
  nodes: WorkflowNode[];
}

/**
 * 闸门决策 —— 工具执行前问引擎「这一步能不能走」。
 *
 * 放在这里（纯类型文件）而不是 `engine.ts`，是因为
 * `src/tools/execute.ts` 也要用它 —— 而执行层不该反过来依赖引擎实现。
 */
export type GateDecision =
  /** 直接执行 */
  | { kind: 'allow'; missionId: string | null; nodeId: string | null }
  /** 拦下，等用户确认 */
  | {
      kind: 'await';
      missionId: string | null;
      message: string;
      confirmHint: string;
      /** 模型改了参数时，把用户已确认的那组参数回传给它 */
      approvedArgs?: unknown;
    }
  /** 用户拒绝了 —— 不再问第三次 */
  | { kind: 'reject'; message: string }
  /** 前置步骤没满足 —— 告诉模型先做什么 */
  | { kind: 'blocked'; missionId: string | null; message: string };

/** 流程定义里查节点 */
export function findNode(
  flow: WorkflowDefinition,
  nodeId: string,
): WorkflowNode | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

/** 流程定义里按工具 key 查节点 */
export function findNodeByTool(
  flow: WorkflowDefinition,
  tool: string,
): WorkflowNode | undefined {
  return flow.nodes.find((n) => n.tool === tool);
}

/**
 * 按触发工具找流程。
 *
 * 触发工具全局唯一，所以最多命中一条；找不到就是「这个工具不属于任何流程」。
 */
export function findFlowByTrigger(tool: string): WorkflowDefinition | undefined {
  return WORKFLOWS.find((f) => f.trigger === tool);
}

/** 按流程类型找定义 */
export function findFlowByType(type: string): WorkflowDefinition | undefined {
  return WORKFLOWS.find((f) => f.type === type);
}

/**
 * 流程定义表。
 *
 * ⚠️ 顺序不影响执行（引擎按 `requires` 推），但**触发工具必须唯一**。
 */
export const WORKFLOWS: readonly WorkflowDefinition[] = [  {
    type: 'refund_request',
    title: '退款申请',
    trigger: 'submit_refund_request',
    nodes: [
      {
        id: 'lookup_order',
        tool: 'query_order_status',
        confirm: false,
        requires: [],
        title: '查订单状态（确认订单存在、已支付）',
      },
      {
        id: 'lookup_coupon',
        tool: 'query_coupon_info',
        confirm: false,
        requires: ['lookup_order'],
        title: '查该订单用过的优惠（算可退金额上限）',
      },
      {
        id: 'confirm_refund',
        tool: 'submit_refund_request',
        confirm: true,
        requires: ['lookup_order', 'lookup_coupon'],
        title: '提交退款申请（需用户确认）',
      },
    ],
  },
  {
    type: 'modify_address',
    title: '收货地址修改',
    trigger: 'update_shipping_address',
    nodes: [
      {
        id: 'lookup_order',
        tool: 'query_order_status',
        confirm: false,
        requires: [],
        title: '查订单状态（确认订单未发货）',
      },
      {
        id: 'confirm_address',
        tool: 'update_shipping_address',
        confirm: true,
        requires: ['lookup_order'],
        title: '修改收货地址（需用户确认）',
      },
    ],
  },
  {
    type: 'after_sale_ticket',
    title: '售后工单',
    trigger: 'create_after_sale_ticket',
    nodes: [
      {
        id: 'lookup_order',
        tool: 'query_order_status',
        confirm: false,
        requires: [],
        title: '查订单状态',
      },
      {
        id: 'lookup_shipping',
        tool: 'query_shipping_track',
        confirm: false,
        requires: [],
        title: '查物流轨迹',
      },
      {
        id: 'create_ticket',
        tool: 'create_after_sale_ticket',
        confirm: true,
        requires: ['lookup_order', 'lookup_shipping'],
        title: '创建售后工单（需用户确认）',
      },
    ],
  },
];
