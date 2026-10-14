import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import 'antd/dist/reset.css';

/**
 * 全局基础样式 —— 仅做重置 + 全局字体；AntD Reset 已处理大部分细节。
 * 详见 docs/04-a §0.2（字体栈包含 PingFang SC / Microsoft YaHei）
 */
const baseStyle = document.createElement('style');
baseStyle.textContent = `
  html, body, #root { height: 100%; }
  /* 弹性布局里的表格默认会按内容撑开页面；滚动留在表格容器里 */
  .ant-layout-has-sider > .ant-layout { min-width: 0; }
  .ant-table-wrapper {
    max-width: 100%;
    overflow-x: auto;
  }
  .ant-table-wrapper .ant-table { width: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-feature-settings: 'tnum' on, 'lnum' on;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    background: #f5f7fa;
  }
  /* 让 AntD 的滚动条更克制 */
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-thumb {
    background: rgba(0,0,0,0.18);
    border-radius: 8px;
  }
  *::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.28); }
  *::-webkit-scrollbar-track { background: transparent; }
`;
document.head.appendChild(baseStyle);

const rootEl = document.getElementById('root');
if (rootEl === null) {
  throw new Error('#root 元素未找到');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
