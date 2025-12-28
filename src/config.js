import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ✅ 固定到项目入口所在目录（更稳，不受 process.cwd() 影响）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 这里 src/config.js 在 src 下，所以回到项目根：../config.json
export const CONFIG_PATH = path.resolve(__dirname, '../config.json');
export const CONFIG_EXAMPLE_PATH = path.resolve(__dirname, '../config.example.jsonc');

export const defaultConfig = {
    debug: false,
    pan115: {
      cookie: '',
      baseURL: 'https://webapi.115.com',
      accessToken: '',
      refreshToken: '',
  
      // ✅ 风控相关：请求限流/节流参数（可按需调）
      listConcurrency: 1,        // 同时最多几个 getFileList 请求（建议 1）
      listMinIntervalMs: 400,    // 两次 list 请求启动间隔（ms，建议 300~600）
  
      // ✅ 缓存 TTL（ms）
      fileListTtlMs: 60_000,       // 目录列表缓存 60s（可调）
      downloadUrlTtlMs: 60_000     // 下载链接缓存 60s（可调）
    },
    webdav: {
      port: 3000,
      username: 'admin',
      password: 'admin',

      // ✅ 安全开关：拦截 Go-http-client/1.1（返回 403）
      blockGoHttpClient: true
    }
  };

export function ensureConfigFile() {
// 生成可读模板（带注释）
if (!fs.existsSync(CONFIG_EXAMPLE_PATH)) {
    fs.writeFileSync(CONFIG_EXAMPLE_PATH, makeExampleJsonc(), 'utf-8');
}

// 生成实际配置（无注释，能 JSON.parse）
if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
    return true;
}
return false;
}

function makeExampleJsonc() {
return `// 这是示例配置（JSONC，带注释）
// 实际运行读取的是 config.json（标准 JSON，不支持注释）
//
// 建议：先复制本文件为 config.json，然后按需填写。
{
// 是否开启调试日志
"debug": false,

"pan115": {
    // 115 登录 cookie（必填）
    "cookie": "",

    // 115 API 基础地址（一般不用改）
    "baseURL": "https://webapi.115.com",

    // OpenAPI 的 accessToken / refreshToken（如果你启用自动刷新，可填写）
    "accessToken": "",
    "refreshToken": "",

    // =============================
    // 风控相关调参（建议从保守开始）
    // =============================

    // getFileList 同时并发请求数（建议 1）
    "listConcurrency": 1,

    // 两次 list 请求启动的最小间隔（毫秒，建议 300~600）
    "listMinIntervalMs": 400,

    // 目录列表缓存 TTL（毫秒）。更大更省请求但更不“实时”
    "fileListTtlMs": 60000,

    // 下载链接缓存 TTL（毫秒）。若链接有效期更短，请调低
    "downloadUrlTtlMs": 60000
},

"webdav": {
    // WebDAV 监听端口
    "port": 3000,

    // Basic Auth 用户名/密码
    "username": "admin",
    "password": "admin",
    // 是否拦截openlist请求下载地址 
    "blockGoHttpClient": true
}
}
`;
}

export function loadConfig() {
  const text = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(text);

  // default -> file (深合并，允许缺字段)
  const cfg = deepMerge(structuredClone(defaultConfig), parsed);

  // 基本校验/修正
  if (!Number.isFinite(cfg.webdav.port)) cfg.webdav.port = 3000;

  return cfg;
}

export function saveConfig(config) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');

  // 尽量设成 600（Linux/macOS）
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}

  return CONFIG_PATH;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source || {})) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      target[key] = deepMerge(tv && typeof tv === 'object' ? tv : {}, sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}
