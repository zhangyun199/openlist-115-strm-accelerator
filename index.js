import { Pan115API } from './src/115api.js';
import { WebDAVServer } from './src/webdav-server.js';
import { ensureConfigFile, loadConfig, saveConfig, CONFIG_PATH } from './src/config.js';

// 1) 确保 config.json 存在，不存在就生成模板
const created = ensureConfigFile();
if (created) {
  console.log(`[config] 已生成配置文件: ${CONFIG_PATH}`);
  console.log('[config] 请编辑 config.json 填入 115 cookie/token 等信息，然后重新启动。');
  process.exit(0);
}

// 2) 只从 config.json 加载
let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`[config] 读取 ${CONFIG_PATH} 失败：`, e);
  process.exit(1);
}

// 3) 必要字段校验
if (!config.pan115.cookie) {
  console.error(`错误: config.json 中 pan115.cookie 为空（文件：${CONFIG_PATH}）`);
  process.exit(1);
}

if (!config.pan115.refreshToken) {
  console.warn('警告: config.json 中 pan115.refreshToken 为空，自动刷新不可用');
  process.exit(1);
}

config.pan115.listConcurrency = Number.isFinite(config.pan115.listConcurrency) ? config.pan115.listConcurrency : 1;
config.pan115.listMinIntervalMs = Number.isFinite(config.pan115.listMinIntervalMs) ? config.pan115.listMinIntervalMs : 400;
config.pan115.fileListTtlMs = Number.isFinite(config.pan115.fileListTtlMs) ? config.pan115.fileListTtlMs : 60_000;
config.pan115.downloadUrlTtlMs = Number.isFinite(config.pan115.downloadUrlTtlMs) ? config.pan115.downloadUrlTtlMs : 60_000;

const panAPI = new Pan115API({
  cookie: config.pan115.cookie,
  baseURL: config.pan115.baseURL,
  accessToken: config.pan115.accessToken,
  refreshToken: config.pan115.refreshToken,

  // ✅ 从 config.json 读取调参项
  listConcurrency: config.pan115.listConcurrency,
  listMinIntervalMs: config.pan115.listMinIntervalMs,
  fileListTtlMs: config.pan115.fileListTtlMs,
  downloadUrlTtlMs: config.pan115.downloadUrlTtlMs,

  debug: config.debug,

  onAuthUpdate: async ({ accessToken, refreshToken }) => {
    const latest = loadConfig();
    latest.pan115.accessToken = accessToken || latest.pan115.accessToken;
    latest.pan115.refreshToken = refreshToken || latest.pan115.refreshToken;
    saveConfig(latest);
  }
});


panAPI.logRuntimeConfig();

// 每 5*60 秒清理一次过期缓存（频率可调）
setInterval(() => {
  panAPI.cleanupExpiredCaches();
}, 5 * 60_000).unref?.();

const webdavServer = new WebDAVServer(panAPI, {
  port: config.webdav.port,
  username: config.webdav.username,
  password: config.webdav.password,
  debug: config.debug,
  blockGoHttpClient: config.webdav.blockGoHttpClient
});

webdavServer.start();
