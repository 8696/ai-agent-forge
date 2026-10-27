import type { ComponentRef, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Empty,
  Input,
  Pagination,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  EditOutlined,
  MergeCellsOutlined,
  PartitionOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import { apiErrorMessage } from '../../lib/apiError';
import {
  editChunk,
  fetchDocumentChunks,
  fetchDocuments,
  mergeChunks,
  resetChunk,
  splitChunk,
  type DocumentChunk,
  type DocumentChunksResult,
  type KnowledgeDocument,
} from '../../lib/adminKnowledge';

const { Text, Paragraph } = Typography;

/** 每页显示多少块 */
const PAGE_SIZE = 20;

/**
 * /admin/knowledge/chunks —— 切片浏览 + 人工编辑
 *
 * **这一页是干什么用的**：把「一份文档被切成了什么样」摊开给人看，
 * 并且**看到不对的当场就能改**。
 *
 * 三个最常见的排查场景：
 *   1. 改完切块规则，要确认新规则生效了（标题有没有被劈开、表格完不完整、块大小合理吗）
 *   2. 问答答错了，要分清是「块切坏了」还是「没召回到」——
 *      「检索测试」页只看得到**命中**的块，这里看得到**全部**块，问题常在没命中的那些里
 *   3. 对比多篇文档的切法（选多篇 → 并排看）
 *
 * ## 编辑是怎么生效的
 *
 * 改一块 → 后端**重算这一块的向量**（一块文本 = 一个向量，不重算的话
 * 检索按旧向量排序却返回新文字，模型会答错）→ 同步 BM25 → 写 DB 权威副本。
 * 没改的块**复用旧向量**，所以改 1 块只多 1 次 embedding 调用。
 *
 * ## 人工编辑会不会被重新索引冲掉
 *
 * 不会 —— 重新索引时人工编辑会按**源区间重叠度**搬回新切的块。
 * 万一搬不回来（切法变了），重新索引的结果里会报「未保留 N 条」，页面上能看到。
 *
 * ⚠️ **不再只是「诊断」**：2026-10-27 起这一页能改了，定位从「只读诊断」
 *    变成「知识库内容校对台」。
 *
 * 数据来自 `GET /api/v1/admin/knowledge/:id/chunks`（src/gateway/admin/knowledge-routes.ts）：
 * 后端先查 DB 确认文档归属本租户，再按 `tenant_id` 过滤 Qdrant —— 两道隔离闸。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.4
 */

/** 正在编辑的那一块 */
interface EditingTarget {
  docId: string;
  chunk: DocumentChunk;
}

export function KnowledgeChunksPage(): ReactElement {
  // ⚠️ **用 App.useApp() 拿 message / modal** —— 静态 `message.xxx()` / `Modal.confirm()`
  //    拿不到主题上下文（深色模式下提示框还是亮色），而且控制台会打 antd 警告
  const { message, modal } = AntdApp.useApp();

  /** 文档下拉的候选（支持服务端按标题搜） */
  const [options, setOptions] = useState<KnowledgeDocument[]>([]);
  /** 见过的所有文档（按 id 索引）—— 搜索过滤后仍能显示已选文档的名字 */
  const [known, setKnown] = useState<Record<string, KnowledgeDocument>>({});
  const [selected, setSelected] = useState<string[]>([]);
  /** 每篇文档各自的页码 */
  const [pages, setPages] = useState<Record<string, number>>({});
  const [data, setData] = useState<Record<string, DocumentChunksResult | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 正在编辑的块 */
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [editText, setEditText] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  /**
   * 编辑框的 DOM 引用 —— 「在光标处拆分」要**从 DOM 读真实光标位置**。
   *
   * ⚠️ 以前只靠 `cursorPos` state，而它只在 `onSelect` 里更新：
   *    打开下一块时不会重置 → 直接点「拆分」会拿上一个块的偏移量切开
   *    （切块是**写库 + 重算向量**的破坏性写，不能静默切错）。
   */
  const textAreaRef = useRef<ComponentRef<typeof Input.TextArea> | null>(null);
  /** 编辑框里的光标位置 —— 只作展示/兜底，拆分以 DOM 为准 */
  const [cursorPos, setCursorPos] = useState(0);

  /** 组件还挂着吗（unmount 后不要再 setState） */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 勾选要合并的块（按文档分组） */
  const [checked, setChecked] = useState<Record<string, number[]>>({});
  const [merging, setMerging] = useState(false);

  /** 拉文档列表（keyword 为空 = 前 100 篇） */
  const loadDocuments = useCallback(async (keyword?: string): Promise<void> => {
    const res = await fetchDocuments({
      page: 1,
      page_size: 100,
      ...(keyword !== undefined && keyword !== '' ? { keyword } : {}),
    });
    if (!mountedRef.current) {
      return;
    }
    setOptions(res.documents);
    setKnown((prev) => {
      const next = { ...prev };
      for (const doc of res.documents) {
        next[doc.id] = doc;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void loadDocuments().catch((err: unknown) => {
      if (!mountedRef.current) {
        return;
      }
      setError(apiErrorMessage(err, '加载文档列表失败'));
    });
  }, [loadDocuments]);

  /** 重新拉某一篇（或多篇）的切片 —— 写操作之后调用 */
  const reload = useCallback(async (docIds: string[]): Promise<void> => {
    const targets = docIds.length > 0 ? docIds : selected;
    if (targets.length === 0) {
      return;
    }
    setLoading(true);
    const results = await Promise.all(
      targets.map(async (id) => {
        try {
          const res = await fetchDocumentChunks(id, {
            page: pages[id] ?? 1,
            page_size: PAGE_SIZE,
          });
          return { id, ok: true as const, res };
        } catch (err: unknown) {
          return { id, ok: false as const, message: apiErrorMessage(err, '加载切片失败') };
        }
      }),
    );
    if (!mountedRef.current) {
      return;
    }
    setData((prev) => {
      const next = { ...prev };
      for (const r of results) {
        next[r.id] = r.ok ? r.res : null;
      }
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      for (const r of results) {
        if (r.ok) {
          delete next[r.id];
        } else {
          next[r.id] = r.message;
        }
      }
      return next;
    });
    setLoading(false);
  }, [selected, pages]);

  useEffect(() => {
    if (selected.length === 0) {
      setData({});
      setErrors({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const results = await Promise.all(
        selected.map(async (id) => {
          try {
            const res = await fetchDocumentChunks(id, {
              page: pages[id] ?? 1,
              page_size: PAGE_SIZE,
            });
            return { id, ok: true as const, res };
          } catch (err: unknown) {
            return { id, ok: false as const, message: apiErrorMessage(err, '加载切片失败') };
          }
        }),
      );
      if (cancelled) {
        return;
      }
      const nextData: Record<string, DocumentChunksResult | null> = {};
      const nextErrors: Record<string, string> = {};
      for (const r of results) {
        if (r.ok) {
          nextData[r.id] = r.res;
        } else {
          nextData[r.id] = null;
          nextErrors[r.id] = r.message;
        }
      }
      setData(nextData);
      setErrors(nextErrors);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, pages]);

  const onSearchDocuments = useCallback(
    (keyword: string): void => {
      void loadDocuments(keyword).catch((err: unknown) => {
        if (!mountedRef.current) {
          return;
        }
        setError(apiErrorMessage(err, '搜索文档失败'));
      });
    },
    [loadDocuments],
  );

  /** 并排展示时每列的宽度：1 篇全宽，2 篇各半，3 篇各三分之一，更多就并排放 */
  const colSpan = useMemo(() => {
    const n = selected.length;
    if (n <= 1) {
      return 24;
    }
    if (n === 2) {
      return 12;
    }
    if (n === 3) {
      return 8;
    }
    return 6;
  }, [selected.length]);

  /**
   * 下拉的候选项 = 当前搜索结果 **+ 已选中的文档**。
   *
   * ⚠️ 不补已选文档的话：搜完之后，已经选中的那篇被过滤掉了 →
   *    antd 的 Select 找不到对应 option → 标签退化成一行裸 id（很难看）。
   */
  const selectOptions = useMemo(() => {
    const list = [...options];
    for (const id of selected) {
      if (!list.some((d) => d.id === id)) {
        const doc = known[id];
        if (doc !== undefined) {
          list.push(doc);
        }
      }
    }
    return list;
  }, [options, selected, known]);

  // ===== 写操作 =====

  const openEditor = useCallback((docId: string, chunk: DocumentChunk): void => {
    setEditing({ docId, chunk });
    setEditText(chunk.text);
    // ⚠️ **光标位置必须重置** —— 不重置的话，上一块拆完关掉、
    //    打开下一块直接点「在光标处拆成两块」，会拿上一块的偏移量把新块切错
    setCursorPos(0);
  }, []);

  const closeEditor = useCallback((): void => {
    setEditing(null);
    setEditText('');
  }, []);

  const saveEdit = useCallback(async (): Promise<void> => {
    if (editing === null) {
      return;
    }
    const trimmed = editText.trim();
    if (trimmed === '') {
      message.error('块内容不能为空');
      return;
    }
    setEditSubmitting(true);
    try {
      const res = await editChunk(editing.docId, editing.chunk.chunk_index, trimmed);
      message.success(`已保存 · 重算了 ${res.embedded} 块的向量（${res.reused} 块复用）`);
      closeEditor();
      await reload([editing.docId]);
    } catch (err: unknown) {
      message.error(apiErrorMessage(err, '保存失败'));
    } finally {
      setEditSubmitting(false);
    }
  }, [editing, editText, closeEditor, reload]);

  /**
   * 在光标处把这一块拆成两块。
   *
   * ⚠️ **位置从 DOM 读，不从 state 读** ——
   *    `cursorPos` 只在 `onSelect` 里更新，可能已经过期（换块、程序化设值、
   *    用户点按钮时焦点不在输入框）。拆分是**写库 + 重算向量**的破坏性写，
   *    位置错了就是把块切坏 —— 宁可报错让用户重摆光标，也不能静默切错。
   */
  const splitAtCursor = useCallback(async (): Promise<void> => {
    if (editing === null) {
      return;
    }
    const ref = textAreaRef.current;
    const node =
      ref?.resizableTextArea?.textArea ??
      (ref?.nativeElement instanceof HTMLTextAreaElement ? ref.nativeElement : null);
    const at = node === null ? null : node.selectionStart;
    if (at === null || at <= 0 || at >= editText.length) {
      message.error('把光标放到要拆分的位置（不能是最开头或最末尾）');
      return;
    }
    setEditSubmitting(true);
    try {
      const res = await splitChunk(editing.docId, editing.chunk.chunk_index, at);
      message.success(`已拆成两块 · 总块数 ${res.chunk_count}`);
      closeEditor();
      await reload([editing.docId]);
    } catch (err: unknown) {
      message.error(apiErrorMessage(err, '拆分失败'));
    } finally {
      setEditSubmitting(false);
    }
  }, [editing, editText, closeEditor, reload]);

  const doReset = useCallback(
    async (docId: string, chunk: DocumentChunk): Promise<void> => {
      try {
        const res = await resetChunk(docId, chunk.chunk_index);
        message.success(`已还原 · 总块数 ${res.chunk_count}`);
        await reload([docId]);
      } catch (err: unknown) {
        message.error(apiErrorMessage(err, '还原失败'));
      }
    },
    [reload],
  );

  const toggleChecked = useCallback((docId: string, index: number, on: boolean): void => {
    setChecked((prev) => {
      const cur = prev[docId] ?? [];
      const next = on ? [...cur, index].sort((a, b) => a - b) : cur.filter((i) => i !== index);
      return { ...prev, [docId]: next };
    });
  }, []);

  const doMerge = useCallback(
    async (docId: string, indexes: number[]): Promise<void> => {
      setMerging(true);
      try {
        const res = await mergeChunks(docId, indexes);
        message.success(`已合并成一块 · 总块数 ${res.chunk_count}`);
        setChecked((prev) => ({ ...prev, [docId]: [] }));
        await reload([docId]);
      } catch (err: unknown) {
        message.error(apiErrorMessage(err, '合并失败'));
      } finally {
        setMerging(false);
      }
    },
    [reload],
  );

  /** 勾选的块是不是连续的（后端只允许合并连续的块） */
  const checkedContinuous = useCallback((indexes: number[]): boolean => {
    const sorted = [...indexes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== (sorted[i - 1] as number) + 1) {
        return false;
      }
    }
    return true;
  }, []);

  return (
    <div>
      <PageHeader
        title="切片浏览"
        subtitle="按文档查看切块结果：确认标题没被劈开、表格完整、块大小合理 —— 发现不对的地方可以直接改。"
        breadcrumb={[{ title: '首页' }, { title: '知识库' }, { title: '切片浏览' }]}
      />

      <Card style={{ marginBottom: 16 }}>
        <Space orientation="vertical" size={10} style={{ width: '100%' }}>
          <Select
            mode="multiple"
            allowClear
            showSearch
            maxTagCount="responsive"
            style={{ width: '100%' }}
            placeholder="选择要查看的文档（可多选，多选时并排对比切法）"
            value={selected}
            onChange={(values: string[]) => setSelected(values)}
            onSearch={onSearchDocuments}
            filterOption={false}
            options={selectOptions.map((d) => ({
              value: d.id,
              label: `${d.title}（${d.chunk_count} 块）`,
            }))}
            notFoundContent={
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的文档" />
            }
          />
          <Space size={6} wrap>
            <SearchOutlined />
            <Text type="secondary" style={{ fontSize: 13 }}>
              块正文的第一行是「标题路径面包屑」（文档名 &gt; 章节 &gt; 小节）——
              这一行会跟着块一起进向量，所以检索时能按章节名命中。
            </Text>
          </Space>
        </Space>
      </Card>

      {error !== null && (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />
      )}

      {selected.length === 0 ? (
        <Card>
          <Empty description="选一篇（或多篇）文档，这里会列出它被切成的每一块" />
        </Card>
      ) : (
        <Spin spinning={loading}>
          <Row gutter={[16, 16]}>
            {selected.map((docId) => {
              const res = data[docId] ?? null;
              const doc = known[docId];
              const docError = errors[docId];
              const picked = checked[docId] ?? [];
              const canMerge = picked.length >= 2 && checkedContinuous(picked);
              return (
                <Col key={docId} xs={24} xl={colSpan}>
                  <Card
                    size="small"
                    title={
                      <Space wrap size={6}>
                        <Text strong>{res?.document.title ?? doc?.title ?? '（加载中）'}</Text>
                        {res !== null && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            共 {res.pagination.total} 块
                          </Text>
                        )}
                        {res?.document.has_manual_edits === true && (
                          <Tooltip title="这篇文档有人工改过的块 —— 重新索引时会尽量保留">
                            <Tag color="orange">有人工编辑</Tag>
                          </Tooltip>
                        )}
                      </Space>
                    }
                    extra={
                      <Space size={6}>
                        <Tooltip
                          title={
                            picked.length < 2
                              ? '勾选两块以上才能合并（只能合并连续的块）'
                              : canMerge
                                ? '把勾选的块合成一块'
                                : '只能合并连续的块'
                          }
                        >
                          <Button
                            size="small"
                            icon={<MergeCellsOutlined />}
                            disabled={!canMerge}
                            loading={merging}
                            onClick={() => {
                              modal.confirm({
                                title: `合并这 ${picked.length} 块？`,
                                content:
                                  '合并后会重算这一块的向量（没动的块复用旧向量）。' +
                                  '合并出来的块可能超过单块的长度上限。',
                                okText: '合并',
                                cancelText: '取消',
                                onOk: () => doMerge(docId, picked),
                              });
                            }}
                          >
                            合并选中（{picked.length}）
                          </Button>
                        </Tooltip>
                        {res !== null && res.pagination.total_pages > 1 ? (
                          <Pagination
                            size="small"
                            current={res.pagination.page}
                            total={res.pagination.total}
                            pageSize={res.pagination.page_size}
                            showSizeChanger={false}
                            onChange={(page: number) =>
                              setPages((prev) => ({ ...prev, [docId]: page }))
                            }
                          />
                        ) : null}
                      </Space>
                    }
                  >
                    {docError !== undefined ? (
                      <Alert type="error" showIcon title={docError} />
                    ) : res === null ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="加载中…"
                      />
                    ) : res.chunks.length === 0 ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="这篇文档在向量库里没有块（可能索引失败或已被删除）"
                      />
                    ) : (
                      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                        {res.chunks.map((chunk) => (
                          <ChunkCard
                            key={chunk.chunk_index}
                            chunk={chunk}
                            checked={picked.includes(chunk.chunk_index)}
                            onToggleCheck={(on: boolean) =>
                              toggleChecked(docId, chunk.chunk_index, on)
                            }
                            onEdit={() => openEditor(docId, chunk)}
                            onReset={() => doReset(docId, chunk)}
                          />
                        ))}
                      </Space>
                    )}
                  </Card>
                </Col>
              );
            })}
          </Row>
        </Spin>
      )}

      {/* 编辑抽屉 */}
      <Drawer
        open={editing !== null}
        title={editing === null ? '' : `编辑第 ${editing.chunk.chunk_index + 1} 块`}
        size={640}
        onClose={closeEditor}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={closeEditor}>取消</Button>
            <Button type="primary" loading={editSubmitting} onClick={() => void saveEdit()}>
              保存
            </Button>
          </Space>
        }
      >
        {editing !== null && (
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              title="保存后会重算这一块的向量并立即生效（检索立刻能命中改后的内容）。"
              description="第一行是标题路径面包屑 —— 它会跟着块一起进向量。想换章节归属的话，改这一行。"
            />
            <Input.TextArea
              ref={textAreaRef}
              value={editText}
              onChange={(e: { target: { value: string } }) => setEditText(e.target.value)}
              onSelect={(e) =>
                setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)
              }
              autoSize={{ minRows: 14, maxRows: 24 }}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              showCount
              maxLength={20000}
            />
            <Space wrap>
              <Button
                icon={<PartitionOutlined />}
                loading={editSubmitting}
                onClick={() => void splitAtCursor()}
              >
                在光标处拆成两块
              </Button>
              {editing.chunk.edited && (
                <Button
                  icon={<UndoOutlined />}
                  onClick={() => {
                    void doReset(editing.docId, editing.chunk).then(closeEditor);
                  }}
                >
                  还原成原始切块
                </Button>
              )}
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              「在光标处拆成两块」：把光标放到要断开的位置再点 —— 拆出来的两块都带同样的面包屑。
              {cursorPos > 0 && cursorPos < editText.length && (
                <> （当前光标在第 {cursorPos + 1} 字）</>
              )}
            </Text>
          </Space>
        )}
      </Drawer>
    </div>
  );
}

function ChunkCard(props: {
  chunk: DocumentChunk;
  checked: boolean;
  onToggleCheck: (on: boolean) => void;
  onEdit: () => void;
  onReset: () => void;
}): ReactElement {
  const { chunk, checked, onToggleCheck, onEdit, onReset } = props;
  const path = chunk.heading_path;
  const sectionTotal = chunk.section_chunk_total ?? 0;
  const sectionIndex = chunk.section_chunk_index ?? 0;
  return (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <Space orientation="vertical" size={6} style={{ width: '100%' }}>
        <Space wrap size={6}>
          <Checkbox checked={checked} onChange={(e) => onToggleCheck(e.target.checked)} />
          <Tag color="blue">第 {chunk.chunk_index + 1} 块</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {chunk.text.length} 字
          </Text>
          {path !== null && path.length > 0 ? (
            <Tooltip title="这块属于文档的哪一节 —— 改切块规则后最重要的观察点">
              <Tag icon={<PartitionOutlined />} color="green">
                {path.join(' > ')}
              </Tag>
            </Tooltip>
          ) : (
            <Tooltip title="这篇文档是在结构感知切块之前入库的，没有标题路径信息。重新索引之后就有了">
              <Tag>无标题路径</Tag>
            </Tooltip>
          )}
          {sectionTotal > 1 && (
            <Tooltip title="这一节被切成了好几块 —— 这是第几块 / 共几块">
              <Tag>本节 {sectionIndex}/{sectionTotal}</Tag>
            </Tooltip>
          )}
          {chunk.edited && (
            <Tooltip title="这块被人工改过（重新索引时会尽量保留）">
              <Tag color="orange">已人工编辑</Tag>
            </Tooltip>
          )}
        </Space>
        <Paragraph
          style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7 }}
          ellipsis={{ rows: 8, expandable: true, symbol: '展开全文' }}
        >
          {chunk.text}
        </Paragraph>
        <Space size={6}>
          <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
            编辑
          </Button>
          {chunk.edited && (
            <Button size="small" icon={<UndoOutlined />} onClick={onReset}>
              还原
            </Button>
          )}
        </Space>
      </Space>
    </Card>
  );
}
