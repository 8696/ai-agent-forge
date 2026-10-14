/**
 * agent-orchestrator 模块 barrel —— 详见 docs/03-b §B.4 + docs/15 §Step 6/7
 *
 * 当前导出：
 *  - tools：Vercel AI SDK tool() 工具定义 + buildTools() 工厂
 *  - loop-stream：流式主对话循环（Step 7：多轮 + 历史 + cache + 摘要压缩）
 *
 * Step 7+ 会加：
 *  - loop.ts：同步版主循环（chat-routes 用，目前复用 loop-stream）
 *  - summarize.ts：搬到模块内（已在 src/lib/summarize.ts 实现）
 */
export { buildTools, knowledgeSearchTool } from './tools';
export { runStreamLoop, type LoopStreamInput, type LoopStreamHandle } from './loop-stream';
