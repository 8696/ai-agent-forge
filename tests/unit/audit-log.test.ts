/**
 * tests/unit/audit-log.test.ts
 * 对应 src/lib/audit-log.ts
 * 详见 docs/12-d-需求-运维稳定.md §D6
 *
 * 注：AuditLog.create 失败时 writeAuditLog 不抛（静默降级）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeAuditLog } from '../../src/lib/audit-log';

// Mock Sequelize model 避免真连 DB
vi.mock('../../src/models', () => {
  const mockAuditLog = {
    create: vi.fn(),
  };
  return {
    AuditLog: mockAuditLog,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AuditLog } = await import('../../src/models');
const mockCreate = AuditLog.create as unknown as ReturnType<typeof vi.fn>;

describe('audit-log · 写日志封装', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('正常调用 → AuditLog.create 收到正确字段', async () => {
    mockCreate.mockResolvedValueOnce({});
    await writeAuditLog({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      action: 'TENANT_STATUS_CHANGE',
      resource_type: 'tenant',
      resource_id: 't-1',
      details: { prev: 'active', next: 'disabled' },
      ip: '127.0.0.1',
    });
    expect(mockCreate).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      action: 'TENANT_STATUS_CHANGE',
      resource_type: 'tenant',
      resource_id: 't-1',
      details: { prev: 'active', next: 'disabled' },
      ip: '127.0.0.1',
    });
  });

  it('AuditLog.create 抛错 → writeAuditLog 不抛（静默降级）', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Table not exists'));
    await expect(
      writeAuditLog({
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        action: 'X',
      }),
    ).resolves.toBeUndefined();
  });

  it('tenant_id 允许 null（system 子系统操作）', async () => {
    mockCreate.mockResolvedValueOnce({});
    await writeAuditLog({
      tenant_id: null,
      user_id: 'sys-1',
      action: 'PLATFORM_OP',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: null, action: 'PLATFORM_OP' }),
    );
  });

  it('缺省字段填 null', async () => {
    mockCreate.mockResolvedValueOnce({});
    await writeAuditLog({
      tenant_id: 't-1',
      user_id: 'u-1',
      action: 'X',
    });
    expect(mockCreate).toHaveBeenCalledWith({
      tenant_id: 't-1',
      user_id: 'u-1',
      action: 'X',
      resource_type: null,
      resource_id: null,
      details: null,
      ip: null,
    });
  });
});
