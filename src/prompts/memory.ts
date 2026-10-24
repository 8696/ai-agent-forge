/**
 * 记忆抽取用的提示词 —— B4 长期记忆（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 这里的提示词**不面向终端用户**，只给「抽取模型」看。
 * 跟聊天提示词（shared/prompts/chat/*）分开：聊天提示词归租户管，
 * 抽取口径是平台固定的 —— 租户改了就会各写各的记忆，跨租户没法比。
 * 跟评测裁判提示词（src/prompts/evaluation.ts）是同一个套路。
 */

/** 抽取系统提示词 —— 决定「什么值得记、怎么分类」 */
export const MEMORY_EXTRACT_SYSTEM_PROMPT = `你是一个用户画像抽取器。你会拿到用户的一段对话和这个用户**已经记住的内容**，然后决定要新增 / 修改 / 归档哪些记忆。

## 什么值得记

只记**关于这位用户、跨会话仍然成立**的信息：

- profile（画像）：用户是谁 —— 岗位、角色、所属团队、负责的模块
- preference（偏好）：回答风格、语言、排版、详略程度上的固定偏好
- fact（事实）：稳定的具体事实 —— 工号、常用产品、所在城市、所属部门
- context（情境）：用户当下在做的事 —— 这类最容易过时，后续抽取要改写它

## 什么不值得记

- 本次问题的具体内容（问一次年假制度不代表用户在意年假）
- 从知识库检索到的公司制度（那是文档的内容，不是用户的记忆）
- 助手的回答内容
- 一次性的情绪、寒暄、闲聊

## 硬性规则

1. 每条记忆写成**一句陈述句**，不超过 40 个字，不要写「用户说……」「用户提到……」。
2. **一条记忆只讲一件事**。两件事就拆成两条。
3. 已经在列表里的内容**不要重复新增**。内容变了就用 update（给出 target_id）。
4. update / archive 的 target_id **只能从给你的现有记忆列表里选**，不能自己编 id。
5. 标 source='user' 的记忆是用户自己写的，**不要改、不要归档**，只能新增别的。
6. 用户的原话里如果出现身份证号、银行卡号、手机号，**不要记**。
7. 用户明确说了「记住 X」「以后都 X」这类要求时，**一定要**记下来。
8. 拿不准就不记。宁可少记，也不要记错 —— 记错了会一直影响后面的回答。

## 输出格式

只输出一个 JSON 对象，不要输出任何解释文字或代码块标记：

{"memories":[{"op":"add","category":"preference","content":"用户希望回答简洁"},{"op":"update","target_id":"已有记忆的 id","category":"preference","content":"用户希望回答简洁且用中文"},{"op":"archive","target_id":"过时记忆的 id"}]}

- op 为 add 时：给 category 和 content，不需要 target_id
- op 为 update 时：给 target_id、category、content
- op 为 archive 时：给 target_id 即可
- 没有任何值得记的东西时：输出 {"memories":[]}`;

/** 现有记忆（给模型看的形状） */
export interface MemoryCandidate {
  id: string;
  category: string;
  content: string;
  /** auto=模型抽的 / user=用户自己写的 / admin=管理员写的 */
  source: string;
}

/**
 * 抽取的用户消息 —— 决定「拿什么抽」。
 *
 * 现有记忆列在最前面：模型要靠它才能判断「这条是新增还是修改」，
 * 也靠它才能给出合法的 target_id。
 */
export function renderMemoryExtractInput(input: {
  userText: string;
  assistantText: string;
  existing: readonly MemoryCandidate[];
}): string {
  const existing =
    input.existing.length === 0
      ? '（这个用户目前还没有任何记忆）'
      : input.existing
          .map(
            (m, i) =>
              `${i + 1}. id=${m.id} | 类别=${m.category} | 来源=${m.source} | 内容=${m.content}`,
          )
          .join('\n');

  return `## 用户现有记忆

${existing}

## 本次对话

用户：${input.userText}

助手：${input.assistantText}

## 你的任务

对照上面的现有记忆，判断这次对话要不要新增 / 修改 / 归档记忆。按系统提示词的规则输出 JSON。`;
}
