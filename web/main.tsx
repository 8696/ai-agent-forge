import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import 'antd/dist/reset.css';

const rootEl = document.getElementById('root');
if (rootEl === null) {
  throw new Error('#root 元素未找到');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
