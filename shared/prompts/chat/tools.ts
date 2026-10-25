/**
 * 可用工具段 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 *
 * 放 shared/ 是因为这一段是**提示词正文**，跟默认提示词 / 资料段 / 摘要段 / 记忆段
 * 一样是纯常量 + 纯函数（不 import 后端任何东西）。
 *
 * ## 为什么单独一段，不烤进默认提示词
 *
 * 租户自定义提示词会**整体替换**基础提示词（src/prompts/index.ts 的 overrideContent）。
 * 如果工具说明烤在默认提示词里，租户一旦改提示词，工具就「消失」了 ——
 * 而模型拿不到工具列表说明，就会老老实实说「我查不了」，工具等于白注册。
 *
 * 所以工具段像摘要段 / 记忆段一样**单独注入**，跟租户改没改提示词无关。
 */

/** 提示词里描述一个工具需要的最小信息 */
export interface ToolPromptItem {
  /** 调用名（模型调用的就是这个名字） */
  name: string;
  /** 描述（租户在后台改过的那版） */
  description: string;
}

/** 用户对一次敏感工具调用的处置 */
export interface ToolApprovalHint {
  /** 工具名 */
  tool_name: string;
  /** 用户确认时的那份入参 */
  args: unknown;
  /**
   *  - `approved` —— 用户点了「确认执行」，等模型再调一次（用同样的参数）
   *  - `rejected` —— 用户点了「取消」，模型不要再调
   */
  state: 'approved' | 'rejected';
}

/**
 * 渲染「可用工具」段。没有工具时返回空串（调用方直接拼进去，不占 token）。
 *
 * 措辞要点：
 *  - 说清楚工具结果是**实时数据**，与「可参考资料」同等权威 —— 否则默认提示词里
 *    「只依据可参考资料回答」那条规则会把模型按死，它不敢用工具
 *  - 说清楚调用失败要**如实说明**，不要编 —— 工具降级时模型最容易幻觉
 *  - **明确要求「问这些就调工具」** —— 描述里已经写了触发场景，这里再钉一遍：
 *    模型很容易凭印象回答（「这个您去官网看」），那工具就白注册了
 */
export function renderToolsBlock(
  tools: readonly ToolPromptItem[],
  pendingApprovals: readonly ToolApprovalHint[] = [],
): string {
  if (tools.length === 0) {
    return '';
  }
  const lines = tools.map((t) => `- \`${t.name}\`：${t.description}`);
  let text =
    '\n## 可用工具\n\n' +
    '你可以调用以下工具获取**实时数据**（订单状态、商品价格、物流轨迹、优惠券等）。' +
    '工具返回的结果与「可参考资料」同等权威，可以直接在回答里引用具体数字。\n' +
    '**遇到上面描述的场景，请直接调用对应工具**，不要凭印象回答，' +
    '也不要把用户打发到「官网 / App 上去看」—— 你有工具能直接查到。\n' +
    '调用失败时如实说明失败原因，不要编造结果；工具没有返回的数据不要凭空推断。\n\n' +
    `${lines.join('\n')}\n`;

  // 用户的确认 / 拒绝还没落地 —— 主动告诉模型该怎么收尾
  //
  // ⚠️ 「已确认」这一段是必需的：光靠用户回一句「确认」，模型可能只回「好的，已提交」
  // 就完了，工具永远没跑（联调时真踩过）。
  const approved = pendingApprovals.filter((p) => p.state === 'approved');
  const rejected = pendingApprovals.filter((p) => p.state === 'rejected');

  if (approved.length > 0) {
    const hints = approved
      .map(
        (p) =>
          `- 请立即用**同样的参数**再调用一次工具 \`${p.tool_name}\`（参数：${JSON.stringify(p.args)}），用户已经确认执行了。`,
      )
      .join('\n');
    text +=
      '\n## 待执行的确认\n\n' +
      '用户刚刚确认了下面这些工具调用，**请立刻用同样的参数再调用一次**，' +
      '不要只回复「好的」就结束。\n\n' +
      `${hints}\n`;
  }

  if (rejected.length > 0) {
    const hints = rejected
      .map((p) => `- \`${p.tool_name}\`（参数：${JSON.stringify(p.args)}）—— 用户已取消，不要再调用。`)
      .join('\n');
    text +=
      '\n## 已取消的调用\n\n' +
      '用户取消了下面这些工具调用，**不要再调用它们**，如实告诉用户已取消即可。\n\n' +
      `${hints}\n`;
  }

  return text;
}
