/**
 * 简单的日志工具
 */
export class Logger {
  constructor(debug = false) {
    this.debug = debug;
  }

  /**
   * 调试日志
   */
  log(...args) {
    if (this.debug) {
      console.log('[DEBUG]', ...args);
    }
  }

  /**
   * 错误日志（始终显示）
   */
  error(...args) {
    console.error('[ERROR]', ...args);
  }

  /**
   * 警告日志（始终显示）
   */
  warn(...args) {
    console.warn('[WARN]', ...args);
  }

  /**
   * 信息日志（始终显示）
   */
  info(...args) {
    console.log('[INFO]', ...args);
  }
}

