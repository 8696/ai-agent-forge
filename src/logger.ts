import pino, { type LoggerOptions } from 'pino';
import { config } from './config';

/**
 * 结构化日志（Pino），JSON 格式方便后面 grep / 上报。
 * 详见 docs/10-观测方案.md
 */
const loggerOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  base: { service: 'agent-platform' },
};

// 仅在开发环境用 pretty 打印，避免污染生产日志结构
if (config.NODE_ENV === 'development') {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service',
    },
  };
}

export const logger = pino(loggerOptions);
