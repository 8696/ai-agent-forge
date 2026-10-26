import type { ReactElement } from 'react';
import { Alert, Button, Card, Flex, Space, Tag, Typography, theme } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, ToolOutlined } from '@ant-design/icons';
import type { ChatUIMessage } from '@shared/types/chat';

/**
 * 工具调用卡片 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 *
 * 一次工具调用 = 一张卡片，挂在 AI 气泡上方（跟引用卡片一个位置）。
 * 让用户能看见「AI 真的去查了，而不是编的」。
 *
 * ⚠️ **敏感工具（awaiting_confirmation）会带一个「确认执行」按钮** ——
 *    后端在闸门那里就把调用拦下了，工具**没有真的执行**。
 *    用户点确认 → 后端记下批准 → 下一轮模型用同样的参数再调一次才真正执行。
 *
 * 匿名挂件（/widget）没有登录态，点不了确认 —— 那边不传 onApprove，
 * 卡片只显示「需要确认」的字样。
 */

const { Text, Paragraph } = Typography;

/** 一次工具调用的记录（与后端 data-tool-call part 的形状一致） */
export interface ToolCallRecord {
  tool_call_id: string;
  /** 注册名（模型调用的就是这个名字） */
  tool_name: string;
  /** 内置实现 key */
  builtin: string;
  args: unknown;
  status: 'ok' | 'error' | 'timeout' | 'awaiting_confirmation' | 'rejected' | 'blocked';
  output: unknown;
  error: string | null;
  duration_ms: number;
  confirm_hint?: string | undefined;
}

/** 从一条 assistant 消息的 parts 里取出工具调用记录 */
export function toolCallsOf(m: ChatUIMessage): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (const part of m.parts) {
    if (part.type === 'data-tool-call') {
      out.push(part.data);
    }
  }
  return out;
}

/** 状态 → 标签 */
function statusTag(status: ToolCallRecord['status']): ReactElement {
  switch (status) {
    case 'ok':
      return (
        <Tag color="green" icon={<CheckCircleOutlined />}>
          调用成功
        </Tag>
      );
    case 'error':
      return (
        <Tag color="red" icon={<CloseCircleOutlined />}>
          调用失败
        </Tag>
      );
    case 'timeout':
      return (
        <Tag color="orange" icon={<ClockCircleOutlined />}>
          超时
        </Tag>
      );
    case 'awaiting_confirmation':
      return <Tag color="orange">待确认</Tag>;
    case 'rejected':
      return <Tag color="default">用户已取消</Tag>;
    case 'blocked':
      // B5 工作流闸门：模型跳过了一步，被拦下来告诉它先做什么
      return <Tag color="blue">前置未满足</Tag>;
    default:
      return <Tag>未知</Tag>;
  }
}

/** 结果摘要：对象就压成一行 JSON，字符串直接显示 */
function summarize(output: unknown): string {
  if (output === null || output === undefined) {
    return '';
  }
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function ToolCallList({
  calls,
  onApprove,
  onReject,
  approvingId,
}: {
  calls: ToolCallRecord[];
  /** 点「确认执行」时回调；不传 = 不显示确认按钮（匿名挂件） */
  onApprove?: ((call: ToolCallRecord) => void) | undefined;
  /** 点「取消」时回调；不传 = 不显示取消按钮 */
  onReject?: ((call: ToolCallRecord) => void) | undefined;
  /** 正在确认中的那次调用（按钮转圈用） */
  approvingId?: string | null | undefined;
}): ReactElement | null {
  const { token } = theme.useToken();
  if (calls.length === 0) {
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {calls.map((call) => {
        const argsText = summarize(call.args);
        const outputText = summarize(call.output);
        return (
          <Card
            key={call.tool_call_id}
            size="small"
            style={{
              borderLeft: `3px solid ${
                call.status === 'ok'
                  ? token.colorSuccess
                  : call.status === 'awaiting_confirmation'
                    ? token.colorWarning
                    : call.status === 'rejected'
                      ? token.colorTextQuaternary
                      : token.colorError
              }`,
              background: token.colorFillQuaternary,
            }}
            styles={{ body: { padding: 10 } }}
          >
            <Flex gap={8} align="center" wrap style={{ marginBottom: 4 }}>
              <ToolOutlined style={{ color: token.colorTextSecondary }} />
              {statusTag(call.status)}
              <Text strong style={{ fontSize: 13 }}>
                {call.tool_name}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {call.duration_ms} ms
              </Text>
            </Flex>

            {argsText !== '' && (
              <Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 4, whiteSpace: 'pre-wrap' }}
                ellipsis={{ rows: 2, expandable: true, symbol: '展开入参' }}
              >
                入参：{argsText}
              </Paragraph>
            )}

            {outputText !== '' && (
              <Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 0, whiteSpace: 'pre-wrap' }}
                ellipsis={{ rows: 3, expandable: true, symbol: '展开结果' }}
              >
                结果：{outputText}
              </Paragraph>
            )}

            {call.status === 'rejected' && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                你已取消这次调用，AI 不会再执行它。
              </Text>
            )}

            {call.status === 'awaiting_confirmation' && (
              <Alert
                style={{ marginTop: 8 }}
                type="warning"
                showIcon
                title={call.confirm_hint ?? '这个操作需要你确认后才会执行'}
                description={
                  onApprove === undefined ? (
                    '当前是匿名会话，无法确认。'
                  ) : (
                    <Space size={12} wrap>
                      <Button
                        type="primary"
                        size="small"
                        loading={approvingId === call.tool_call_id}
                        onClick={() => onApprove(call)}
                      >
                        确认执行
                      </Button>
                      {onReject !== undefined && (
                        <Button
                          size="small"
                          danger
                          loading={approvingId === call.tool_call_id}
                          onClick={() => onReject(call)}
                        >
                          取消
                        </Button>
                      )}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        确认后 AI 会用同样的参数再调一次，这次会真的执行；取消后就不会再问了。
                      </Text>
                    </Space>
                  )
                }
              />
            )}
          </Card>
        );
      })}
    </div>
  );
}
