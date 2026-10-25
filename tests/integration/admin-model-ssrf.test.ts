/**
 * tests/integration/admin-model-ssrf.test.ts
 * C4 模型选择：**编辑**路径的 base_url 也必须过 SSRF 闸门
 *
 * 对应 src/services/tenant-models.ts（updateTenantModel / normalizeBaseUrl）
 *
 * ⚠️ **回归**：之前「编辑时留空 API Key = 保持原样」这条默认路径
 *    （docs/04-c §5.4.1 明写「编辑时留空 API Key = 保持原样，不重填也能改别的字段」）
 *    走的是 `row.base_url = input.base_url` —— **不解析 DNS、不判私网 / 云元数据、
 *    也不做 /v1 归一化**，等于绕开了新建时的闸门。
 *
 *    后果：租户 admin 在生产环境能把端点指到 `169.254.169.254` 读云元数据，
 *    或指到内网地址打穿 —— 而这条路径是**默认路径**，不需要重填密钥。
 *
 * 直接打服务层（`updateTenantModel`）而不是 HTTP：
 * 闸门就在服务层，这样断言不依赖后端进程是不是刚重启过。
 *
 * 用 `file://` 协议做断言，而不是私网 IP：
 *   协议检查在 `allowPrivateEndpoint()` **之前**执行（src/lib/llm-endpoint.ts），
 *   所以不管测试环境有没有放开内网，`file://` 一律被拒 ——
 *   断言不依赖环境变量，跑得稳。
 *
 * 前置条件：能连上 MySQL（其它集成测试同款）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';
import { getSequelize } from '../../src/db';
import { Tenant, TenantModel } from '../../src/models';
import { encryptSecret, secretHint, decryptSecret } from '../../src/lib/crypto';
import { updateTenantModel } from '../../src/services/tenant-models';

const TEST_MODEL_PREFIX = '测试-ssrf-';

describe('C4 · 编辑模型时 base_url 也要过 SSRF 闸门', () => {
  let tenantId: string;
  const createdModelIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    const tenant = await Tenant.findOne({ where: { code: 'acme' } });
    expect(tenant).not.toBeNull();
    tenantId = tenant!.id;

    await TenantModel.destroy({
      where: { tenant_id: tenantId, name: { [Op.like]: `${TEST_MODEL_PREFIX}%` } },
    });
  });

  afterAll(async () => {
    if (createdModelIds.length > 0) {
      await TenantModel.destroy({ where: { id: createdModelIds } });
    }
  });

  /** 造一条模型条目（key 用测试密文，够用即可） */
  const createModel = async (): Promise<string> => {
    const row = await TenantModel.create({
      tenant_id: tenantId,
      name: `${TEST_MODEL_PREFIX}${Date.now()}`,
      provider: 'custom',
      model_id: 'test-ssrf-model',
      base_url: 'http://127.0.0.1:9/v1',
      api_key_enc: encryptSecret('sk-test-dummy'),
      api_key_hint: secretHint('sk-test-dummy'),
      usage_scope: 'chat',
      is_active: false,
    });
    createdModelIds.push(row.id);
    return row.id;
  };

  it('编辑时留空 api_key（= 保持原样）仍会校验 base_url 并拒掉非法协议', async () => {
    const id = await createModel();

    await expect(
      updateTenantModel(tenantId, id, 'test-user', {
        name: '改名试试',
        provider: 'custom',
        model_id: 'test-ssrf-model',
        // **不带 api_key** —— 这是后台的默认编辑路径
        base_url: 'file:///etc/passwd',
        temperature: 0.2,
        max_output_tokens: 2048,
        prompt_cache_enabled: false,
      }),
    ).rejects.toThrow();
  });

  it('被拒的编辑不会把非法 base_url 写进库', async () => {
    const id = await createModel();
    const before = await TenantModel.findByPk(id);
    const beforeUrl = before?.base_url;

    await updateTenantModel(tenantId, id, 'test-user', {
      name: '改名试试',
      provider: 'custom',
      model_id: 'test-ssrf-model',
      base_url: 'file:///etc/passwd',
      temperature: 0.2,
      max_output_tokens: 2048,
      prompt_cache_enabled: false,
    }).catch(() => undefined);

    const after = await TenantModel.findByPk(id);
    expect(after?.base_url).toBe(beforeUrl);
  });

  it('合法 base_url 的编辑（同样留空 api_key）能正常通过，密钥保持原样', async () => {
    const id = await createModel();
    const before = await TenantModel.findByPk(id);
    const beforeKey = before?.api_key_enc;

    await updateTenantModel(tenantId, id, 'test-user', {
      name: '改名试试',
      provider: 'custom',
      model_id: 'test-ssrf-model',
      base_url: 'http://127.0.0.1:9/v1',
      temperature: 0.3,
      max_output_tokens: 2048,
      prompt_cache_enabled: false,
    });

    const after = await TenantModel.findByPk(id);
    expect(after?.name).toBe('改名试试');
    // temperature 列存的是字符串（跟其他租户级数值字段一致）
    expect(Number(after?.temperature)).toBe(0.3);
    // 密钥保持原样（编辑没带 api_key，不该被清空）
    expect(decryptSecret(after!.api_key_enc)).toBe('sk-test-dummy');
  });
});
