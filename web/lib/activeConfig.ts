import { useEffect, useState } from 'react';
import axios from 'axios';

/**
 * 当前激活的 LLM / Embedding 配置（公共元信息，无需鉴权）
 * 详见 docs/06-API接口.md §6.4
 *
 * 用途：3 个子系统页脚展示「当前生效」的模型。
 * 设计：
 *  - 公共端点（不挂 token），任何页面都能拿
 *  - 用原生 axios，不走子系统 api 实例（避免子系统未登录时被拦截器绕到登录页）
 *  - 失败容错：拿不到就显示「—」，不让页脚崩
 */
export interface ActiveConfig {
  provider: string;
  llmModel: string;
  embedModel: string;
  embedDimensions: number;
}

const EMPTY: ActiveConfig = {
  provider: '',
  llmModel: '',
  embedModel: '',
  embedDimensions: 0,
};

export function useActiveConfig(): ActiveConfig {
  const [cfg, setCfg] = useState<ActiveConfig>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    axios
      .get<ActiveConfig>('/api/v1/active-config', { timeout: 3000 })
      .then((res) => {
        if (cancelled) return;
        setCfg(res.data);
      })
      .catch(() => {
        if (cancelled) return;
        // 静默：页脚不强依赖，缺了就显示「—」
        setCfg(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return cfg;
}
