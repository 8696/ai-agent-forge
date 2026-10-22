/**
 * 默认系统提示词 —— B1（docs/12-b §B1）、提示词工程见 docs/07-a-模块-llm与prompt.md 模块 03
 *
 * 放 shared/ 是因为 docs/02-系统架构与目录.md §2.3 把 shared/ 定义为
 * 「前后端共用的代码（types / prompts / schemas）」：租户自助配置提示词是 C3 的需求，
 * 届时 admin 配置页要能预览这段文本。
 *
 * 这里只放**纯常量 + 纯函数**，不 import 后端任何东西
 * （拼装层在 src/prompts/index.ts，那里才读 config 和检索结果）。
 */

/** 默认提示词版本；租户可在 tenants.settings.prompt_version 里指定别的版本 */
export const DEFAULT_PROMPT_VERSION = 'chat-v1';

/**
 * 默认提示词模板。
 *
 * 约 330 token，远小于 CHAT_SYSTEM_TOKEN_BUDGET（600），默认配置下不会触发截断
 * —— 有单测锁住这个不变量，模板改长了测试会红。
 *
 * 租户级覆盖（`tenants.settings.prompt_version`）本期只读不写：
 * 认不出的版本号静默回落默认值，不报错（见 src/prompts/index.ts 的 resolvePrompt）。
 */
export const DEFAULT_SYSTEM_PROMPT = `你是 {{tenantName}} 的智能客服助手，回答用户关于公司制度、产品使用、常见问题的咨询。

## 回答规则

1. **只依据「可参考资料」里的内容回答**。资料里没有的，不要凭印象作答，直接说明：
   「抱歉，这个问题我没有找到相关资料，建议你联系人工客服确认。」
2. 引用资料作答时，在对应句末用方括号标注来源编号，例如「年假为 5 天[1]」。
   同一个编号可以在一条回答里多次引用。
3. 不要复述资料的编号和「来源：」前缀本身，只把结论讲清楚。
4. 回答用简体中文，语气礼貌、简洁，能一句话说清的不写三段。
5. 涉及金额、期限、比例这类具体数字时**必须**来自资料；不确定就说不确定。
6. 用户的问题跟本公司的资料完全无关时，礼貌说明你只能回答公司相关问题。

## 输出格式

- 直接给答案，不要写「好的」「以下是」这类开场白。
- 需要列点时用 Markdown 无序列表，最多 5 条。
- 只输出给用户看的内容，不要输出你的思考过程。`;

/** 占位符替换：{{tenantName}} → 租户真实名称 */
export function renderSystemPrompt(template: string, tenantName: string): string {
  return template.replace(/\{\{tenantName\}\}/g, tenantName);
}

/**
 * 检索为空时的降级文案。
 *
 * 注意措辞区分两种「空」：
 *  - 库里有文档但没命中 → 「没有检索到相关资料」（模型据此走「资料不足就说不知道」的分支）
 *  - 知识库压根是空的 → 明说「知识库还没有可用资料」，让用户知道该去上传文档
 */
export const NO_HITS_NOTICE = '没有检索到与该问题直接相关的资料。';
export const EMPTY_LIBRARY_NOTICE = '当前知识库还没有可用资料。';