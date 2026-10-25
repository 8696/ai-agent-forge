import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { Children, isValidElement, useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { Button, Tooltip, theme } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { useThemeMode } from '../lib/themeMode';

// highlight.js 自带两套配色。直接 import 的话两套都会生效（后 import 的赢），
// 所以用 Vite 的 `?inline` 拿到 CSS 文本，按当前主题注入一份。
import hljsLightCss from 'highlight.js/styles/github.css?inline';
import hljsDarkCss from 'highlight.js/styles/github-dark.css?inline';

/**
 * Markdown 渲染 —— docs/04-d §7 公共组件 / docs/04-b §4.7 特殊元素
 *
 * 规格要求（04-b §4.7）：
 *  - **代码块用 highlight.js 高亮 + 右上角复制按钮**
 *  - **引用块**：左侧蓝色边 + 浅灰背景
 *  - **链接**：自动识别 + 新窗口打开
 *  - **表格** → HTML 表格（remark-gfm）
 *
 * ⚠️ 为什么单独抽成组件：之前 ChatPage 和 WidgetPage 各写了一份裸
 *    `<Markdown remarkPlugins={[remarkGfm]} />` —— 高亮、复制、引用块样式
 *    两边都没有，而且要加就得改两处。
 */
interface MarkdownProps {
  children: string;
  /** 额外的行内样式（比如气泡内的字号 / 颜色） */
  style?: CSSProperties | undefined;
}

export function Markdown(props: MarkdownProps): ReactElement {
  const { token } = theme.useToken();
  const mode = useThemeMode();

  // highlight.js 的配色：跟着主题切（深色下用 github-dark）
  useEffect(() => {
    const css = mode === 'dark' ? hljsDarkCss : hljsLightCss;
    let el = document.querySelector<HTMLStyleElement>('style[data-hljs-theme]');
    if (el === null) {
      el = document.createElement('style');
      el.setAttribute('data-hljs-theme', 'true');
      document.head.appendChild(el);
    }
    if (el.textContent !== css) {
      el.textContent = css;
    }
  }, [mode]);

  const components = useMemo<Components>(
    () => ({
      /**
       * 代码块 —— highlight.js 高亮 + 右上角复制按钮。
       *
       * react-markdown v9+ 不再给 `code` 传 `inline` 属性了，
       * 所以在 `pre` 这一层处理（块级代码的 raw 文本和语言都在这拿）。
       */
      pre({ children }) {
        const child = Children.toArray(children)[0];
        const props = isValidElement(child)
          ? (child.props as { className?: unknown; children?: ReactNode })
          : {};
        const className = typeof props.className === 'string' ? props.className : '';
        const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? '';
        const raw = (
          Array.isArray(props.children) ? props.children.join('') : String(props.children ?? '')
        ).replace(/\n$/, '');

        let html: string;
        if (language !== '' && hljs.getLanguage(language)) {
          html = hljs.highlight(raw, { language }).value;
        } else {
          html = hljs.highlightAuto(raw).value;
        }

        return (
          <CodeBlock language={language} html={html} raw={raw} token={token} />
        );
      },

      /** 引用块：左侧蓝色边 + 浅灰背景（04-b §4.7） */
      blockquote({ children }) {
        return (
          <blockquote
            style={{
              margin: '10px 0',
              padding: '6px 14px',
              borderLeft: `3px solid ${token.colorPrimary}`,
              background: token.colorBgSpotlight,
              borderRadius: 4,
              color: token.colorTextSecondary,
            }}
          >
            {children}
          </blockquote>
        );
      },

      /** 链接：新窗口打开（04-b §4.7「自动识别 + 新窗口打开」） */
      a({ children, href, ...rest }) {
        return (
          <a
            {...rest}
            {...(href !== undefined ? { href } : {})}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: token.colorLink, textDecoration: 'underline' }}
          >
            {children}
          </a>
        );
      },
    }),
    [token],
  );

  return (
    <div style={props.style}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {props.children}
      </ReactMarkdown>
    </div>
  );
}

/** 代码块：标题条（语言 + 复制按钮）+ 高亮正文 */
function CodeBlock(props: {
  language: string;
  html: string;
  raw: string;
  token: ReturnType<typeof theme.useToken>['token'];
}): ReactElement {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(props.raw)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // 剪贴板不可用（老浏览器 / 非 https）—— 不弹错，复制按钮本身就是可选路径
      });
  }, [props.raw]);

  return (
    <div
      style={{
        margin: '10px 0',
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${props.token.colorBorderSecondary}`,
        background: props.token.colorBgSpotlight,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px 4px 12px',
          background: props.token.colorBgElevated,
          borderBottom: `1px solid ${props.token.colorBorderSecondary}`,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: props.token.colorTextTertiary,
            fontFamily: 'monospace',
          }}
        >
          {props.language === '' ? 'text' : props.language}
        </span>
        <Tooltip title={copied ? '已复制' : '复制代码'}>
          <Button
            type="text"
            size="small"
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={onCopy}
            aria-label="复制代码"
          />
        </Tooltip>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          overflowX: 'auto',
          fontSize: 13,
          lineHeight: 1.6,
          background: 'transparent',
        }}
      >
        <code
          className="hljs"
          // ⚠️ html 来自 highlight.js —— 它自己会转义原始文本里的 < > &，
          //    不会把用户内容当 HTML 执行
          dangerouslySetInnerHTML={{ __html: props.html }}
        />
      </pre>
    </div>
  );
}
