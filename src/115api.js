import axios from 'axios';
import FormData from 'form-data';
import { Logger } from './logger.js';


class SimpleLimiter {
  constructor({ concurrency = 1, minIntervalMs = 200 } = {}) {
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;

    this.active = 0;
    this.queue = [];
    this.lastStartAt = 0;
  }

  async run(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.active >= this.concurrency) return;
    const item = this.queue.shift();
    if (!item) return;

    this.active++;

    try {
      // 确保两次启动之间至少间隔 minIntervalMs
      const now = Date.now();
      const wait = Math.max(0, this.minIntervalMs - (now - this.lastStartAt));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastStartAt = Date.now();

      const res = await item.taskFn();
      item.resolve(res);
    } catch (e) {
      item.reject(e);
    } finally {
      this.active--;
      // 继续跑队列
      this._drain();
    }
  }
}

/**
 * 115网盘API客户端
 */
export class Pan115API {
  constructor(options = {}) {
    // =========================
    // 1) 基础配置（API & 鉴权）
    // =========================
    this.baseURL = options.baseURL || 'https://webapi.115.com';
    this.cookie = options.cookie || '';

    // 115open token（accessToken 会过期，refreshToken 用于刷新）
    this.accessToken = options.accessToken || '';
    this.refreshToken = options.refreshToken || '';

    // token 更新回调：刷新成功后把新 token 写回 config.json（外层注入）
    this.onAuthUpdate = options.onAuthUpdate;

    this.logger = new Logger(!!options.debug);

    // =========================
    // 2) 缓存（降低请求频率，避免风控）
    // =========================

    // (A) 路径 -> id 映射缓存
    // 用途：把 "/影视文件/电影" 解析成网盘的目录 id，减少逐级查找开销
    // 结构：path -> { id, type, name, ... }
    this.pathToIdCache = new Map();

    // (B) 目录列表缓存：cid -> files（核心：减少 /files 调用次数）
    // TTL：默认 60 秒（WebDAV 频繁 PROPFIND 时能显著降压；想“更实时”就调小）
    // 结构：cid -> { expiresAt, files }
    this._fileListCache = new Map();
    this.fileListTtlMs = options.fileListTtlMs ?? 60_000;

    // (C) 下载链接缓存：同一个文件 + 同一个 UA，60 秒内复用下载 URL
    // 注意：若下载 URL 本身有效期更短，可把 TTL 调低（例如 10~30 秒）
    // 结构：key(fileId|pickcode|ua) -> { expiresAt, value:{url,userAgent} }
    this._downloadUrlCache = new Map();
    this.downloadUrlTtlMs = options.downloadUrlTtlMs ?? 60_000;

    // =========================
    // 3) 限流/合并（抗并发，降低风控）
    // =========================

    // getFileList 限流：控制并发 + 请求间隔
    // - concurrency：同时最多几个 list 请求（建议 1 起步）
    // - minIntervalMs：两次 list 请求启动的最小间隔（建议 300~600ms）
    this.listConcurrency = options.listConcurrency ?? 1;
    this.listMinIntervalMs = options.listMinIntervalMs ?? 350;

    this._listLimiter = new SimpleLimiter({
      concurrency: this.listConcurrency,
      minIntervalMs: this.listMinIntervalMs
    });

    // getFileList 合并：同一个 cid 并发请求只发一次（singleflight）
    // 结构：cid -> Promise<files[]>
    this._listInflight = new Map();

    // 下载链接合并：同一个 key 并发请求只发一次
    // 结构：key -> Promise<{url,userAgent}>
    this._downloadUrlInflight = new Map();
    this.downloadConcurrency = options.downloadConcurrency ?? 1;
    this.downloadMinIntervalMs = options.downloadMinIntervalMs ?? 1000;
    
    this._downloadLimiter = new SimpleLimiter({
      concurrency: this.downloadConcurrency,
      minIntervalMs: this.downloadMinIntervalMs
    });
    // =========================
    // 4) Token 刷新 singleflight（避免并发刷新）
    // =========================

    // 同一时间只允许一个 refresh 在跑，其它调用复用同一 Promise
    this._refreshPromise = null;

    // 可选：刷新防抖，避免短时间重复刷新（毫秒时间戳）
    this._lastRefreshAt = 0;

    // 用于调用115内部API的客户端
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Cookie': this.cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 115Browser/36.0.0 Chromium/125.0',
        'Accept':  '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'keep-alive',
        'Origin':  'https://115.com',
        'Referer': 'https://115.com/',
        'Sec-Fetch-Dest':  'empty',
        'Sec-Fetch-Mode':  'cors',
        'Sec-Fetch-Site':  'same-site',
        'sec-ch-ua':  '"Chromium";v="125", "Not.A/Brand";v="24"',
        'sec-ch-ua-mobile':  '?0',
        'sec-ch-ua-platform':  '"macOS"',
      }
    });

    // 用于调用115开放API的客户端
    // 定义统一的User-Agent，确保获取下载链接和访问下载链接时使用相同的UA
    this.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    
    this.openClient = axios.create({
      baseURL: 'https://proapi.115.com',
      headers: {
        'Authorization': this.accessToken ? `Bearer ${this.accessToken}` : '',
        'User-Agent': this.userAgent,
        'Accept': 'application/json',
      }
    });
    this.openClientPassportApi = axios.create({
      baseURL: 'https://passportapi.115.com',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });
  }

  logRuntimeConfig() {
    this.logger.log(
      `[API] listConcurrency=${this.listConcurrency}, ` +
      `listMinIntervalMs=${this.listMinIntervalMs}, ` +
      `fileListTtlMs=${this.fileListTtlMs}, ` +
      `downloadUrlTtlMs=${this.downloadUrlTtlMs}`
    );
  }
  
  cleanupExpiredCaches() {
    const now = Date.now();
  
    // 目录列表缓存
    for (const [k, v] of this._fileListCache) {
      if (!v || v.expiresAt <= now) this._fileListCache.delete(k);
    }
  
    // 下载链接缓存
    for (const [k, v] of this._downloadUrlCache) {
      if (!v || v.expiresAt <= now) this._downloadUrlCache.delete(k);
    }
  }

  // 清指定目录 cid 的列表缓存
  invalidateFileListCacheById(cid) {
    if (!cid) return;
    this._fileListCache.delete(String(cid));
  }

  // 清指定路径的缓存（目录列表 + 路径映射）
  invalidateByPath(path) {
    const p = path === '/' ? '/' : path.replace(/\/+$/g, ''); // 去掉末尾 /
    const hit = this.pathToIdCache.get(p);

    // 删路径映射
    this.pathToIdCache.delete(p);

    // 删目录列表缓存
    if (hit?.id) this.invalidateFileListCacheById(hit.id);

    // 根目录
    if (p === '/') this.invalidateFileListCacheById('0');

    return hit?.id;
  }

  // 可选：刷新并预热（立刻拉一次最新列表填入缓存）
  async refreshDirectoryByPath(path) {
    const p = path === '/' ? '/' : path.replace(/\/+$/g, '');
    // 先解析 id（你已有 getFileByPath）
    if (p === '/') {
      this.invalidateFileListCacheById('0');
      await this.getFileList('0'); // 预热
      return { id: '0', path: '/' };
    }

    const dir = await this.getFileByPath(p);
    if (!dir || dir.type !== 'directory') return null;

    this.invalidateFileListCacheById(dir.id);
    await this.getFileList(dir.id); // 预热
    return { id: dir.id, path: p };
  }

    /**
   * 缓存路径到ID的映射
   * @param {string} parentPath - 父路径
   * @param {Array} files - 文件列表
   */
    cachePaths(parentPath, files) {
      files.forEach(file => {
        // 构建完整路径
        const fullPath = parentPath === '/' 
          ? `/${file.name}` 
          : `${parentPath}/${file.name}`;
        
        // 如果是文件夹，路径需要以/结尾
        const pathToCache = file.type === 'directory' && !fullPath.endsWith('/')
          ? `${fullPath}/`
          : fullPath;
        
        // 缓存路径到ID的映射
        this.pathToIdCache.set(fullPath, file);
        
        this.logger.log(`[API] 缓存路径映射: ${pathToCache} -> ${file.id} (${file.type})`);
      });
    }

  formatPathList(data) {
    
    // 实际响应格式：data.path 是数组，包含路径
    const pathList = data.path || [];
    let pathString = '/';

    pathList.forEach(path => {
      if (path.name === '根目录') {
        pathString = '/';
      } else {
        pathString += `${path.name}/`;
      }
    })
    if (pathString.endsWith('/') && pathString.length > 1) {
      pathString = pathString.slice(0, -1)
    }
    return pathString;
  }
  
  /**
   * 获取文件列表
   * @param {string} fileId - 文件夹ID，默认为根目录
   * @returns {Promise<Array>}
   */
  async getFileList(fileId = '0') {
    const key = String(fileId);
    const cached = this._fileListCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.logger.log(`[API] getFileList 命中缓存 - fileId: ${key}`);
      return cached.files;
    }
  
    // ✅ 同一目录并发请求合并（singleflight）
    const inflight = this._listInflight.get(key);
    if (inflight) {
      this.logger.log(`[API] getFileList 合并并发请求 - fileId: ${key}`);
      return inflight;
    }
  
    // ✅ 通过 limiter 控制并发 + 节流
    const p = this._listLimiter.run(() => this._getFileListImpl(key));
  
    this._listInflight.set(key, p);
    try {
      return await p;
    } finally {
      this._listInflight.delete(key);
    }
  }

  async _getFileListImpl(fileId = '0') {
    try {
      this.logger.log(`[API] 获取文件列表 - fileId: ${fileId}`);
  
      let response = await this.client.get('/files', {
        params: {
          aid: 1,
          cid: fileId,
          offset: 0,
          limit: 200,
          type: 0,
          show_dir: 1,
          fc_mix: 0,
          natsort: 1,
          count_folders: 1,
          format: 'json',
          custom_order: 0,
        }
      });
  
      this.logger.log(
        `[API] 文件列表响应 - state: ${response.data?.state}, errNo: ${response.data?.errNo || 'N/A'}, count: ${response.data?.count || 0}`
      );
  
      // 检查是否需要使用备用API
      if (response.data && response.data.state === false && response.data.errNo === 20130827) {
        this.logger.log(`[API] 检测到errNo 20130827，使用备用API: https://aps.115.com/natsort/files.php`);
        response =  await this.getFileListFromBackup(fileId);

      }
  
      if (response.data && response.data.state !== false) {
        const files = this.formatFileList(response.data);
        this.logger.log(`[API] 格式化后文件数量: ${files.length}`);
        const pathString = this.formatPathList(response.data);
        this._fileListCache.set(String(fileId), {
          files,
          expiresAt: Date.now() + this.fileListTtlMs
        });
        this.cachePaths(pathString, files);
        return files;
      }
  
      return [];
    } catch (error) {
      this.logger.error('获取文件列表失败:', error.message);
      throw error;
    }
  }
  

  /**
   * 使用备用API获取文件列表
   * @param {string} fileId - 文件夹ID
   * @returns {Promise<Array>}
   */
  async getFileListFromBackup(fileId = '0') {
    try {
      this.logger.log(`[API] 使用备用API获取文件列表 - fileId: ${fileId}`);
      
      const response = await axios.get('https://aps.115.com/natsort/files.php', {
        params: {
          aid: 1,
          cid: fileId,
          offset: 0,
          limit: 200,
          type: 0,
          show_dir: 1,
          fc_mix: 0,
          natsort: 1,
          count_folders: 1,
          format: 'json',
          custom_order: 0,
          o: 'file_name',
          asc: 1
        },
        headers: {
          'Cookie': this.cookie,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 115Browser/36.0.0 Chromium/125.0',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Connection': 'keep-alive',
          'Origin': 'https://115.com',
          'Referer': 'https://115.com/',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
        }
      });

      this.logger.log(`[API] 备用API响应 - state: ${response.data?.state}, count: ${response.data?.count || 0}`);
      
      if (response.data && response.data.state !== false) {
        const files = this.formatFileList(response.data);
        this.logger.log(`[API] 备用API格式化后文件数量: ${files.length}`);
        // const pathString = this.formatPathList(response.data);
        // this.cachePaths(pathString, files);
        return response;
      }
      
      this.logger.warn(`[API] 备用API也返回失败状态`);
      return [];
    } catch (error) {
      this.logger.error('备用API获取文件列表失败:', error.message);
      throw error;
    }
  }

  /**
   * 格式化文件列表
   * @param {Object} data - API返回的原始数据
   * @returns {Array}
   */
  formatFileList(data) {
    const files = [];
    
    // 实际响应格式：data.data 是数组，包含文件和文件夹
    const items = data.data || [];
    
    items.forEach(item => {
      // 判断是文件夹还是文件：
      // 文件有 fid 字段，文件夹有 cid 字段且没有 fid 字段
      if (item.fid) {
        // 文件
        files.push({
          id: item.fid,
          name: item.n || '',
          type: 'file',
          size: parseInt(item.s) || 0,
          mtime: this.parseTimestamp(item.te || item.t || item.tu || Date.now() / 1000),
          sha1: item.sha || '',
          pickcode: item.pc || '',
          path: `/${item.n || ''}`
        });
      } else if (item.cid && item.cid !== '0') {
        // 文件夹（有 cid 且不是 "0"）
        const folder = {
          id: item.cid,
          name: item.n || '',
          type: 'directory',
          size: 0,
          mtime: this.parseTimestamp(item.te || item.t || item.tu || Date.now() / 1000),
          pickcode: item.pc || '',
          path: `/${item.n || ''}`
        };
        this.logger.log(`[API] 识别为文件夹: ${folder.name}, cid: ${folder.id}`);
        files.push(folder);
      } else {
        // 未识别的项目
        this.logger.log(`[API] 未识别的项目:`, JSON.stringify(item));
      }
    });

    return files;
  }

  /**
   * 解析时间戳
   * @param {string|number} timestamp - 时间戳（可能是字符串格式的日期或Unix时间戳）
   * @returns {number} Unix时间戳（秒）
   */
  parseTimestamp(timestamp) {
    if (!timestamp) {
      return Date.now() / 1000;
    }
    
    // 如果是数字，直接返回
    if (typeof timestamp === 'number') {
      return timestamp;
    }
    
    // 如果是字符串格式的日期（如 "2025-04-03 17:31"）
    if (typeof timestamp === 'string' && timestamp.includes('-')) {
      const date = new Date(timestamp);
      return isNaN(date.getTime()) ? Date.now() / 1000 : date.getTime() / 1000;
    }
    
    // 如果是字符串格式的数字
    const num = parseInt(timestamp);
    if (!isNaN(num)) {
      // 如果数字很大（10位以上），可能是毫秒时间戳，需要除以1000
      return num > 10000000000 ? num / 1000 : num;
    }
    
    return Date.now() / 1000;
  }

  async refreshAccessToken() {
    // ✅ 如果已经有刷新在进行，直接复用同一个 Promise
    if (this._refreshPromise) {
      this.logger.log('[API] refreshAccessToken: 复用进行中的刷新请求');
      return this._refreshPromise;
    }
  
    // ✅ 可选：简单防抖（比如 2 秒内不重复刷新）
    const now = Date.now();
    if (now - this._lastRefreshAt < 2000 && this.accessToken) {
      this.logger.log('[API] refreshAccessToken: 刚刷新过，跳过（防抖）');
      return { accessToken: this.accessToken, refreshToken: this.refreshToken };
    }
  
    // ✅ 把真正的刷新逻辑包进一个 Promise 并保存
    this._refreshPromise = (async () => {
      this.logger.log(`[API] 刷新token - access_token`);
  
      if (!this.refreshToken) {
        this.logger.warn(`[API] 未设置 refreshToken`);
        throw new Error('refreshToken is empty');
      }
  
      const headers = { 'User-Agent': this.userAgent };
      const body = { refresh_token: this.refreshToken };
  
      const response = await this.openClientPassportApi.post('/open/refreshToken', body, { headers });
  
      const resp = response?.data;
      if (!resp) throw new Error('API响应为空');
  
      if (resp.state === false) {
        const errorMsg = resp.message || `API错误 (code: ${resp.code || 'unknown'})`;
        throw new Error(errorMsg);
      }
  
      const payload = resp.data || {};
      const newAccessToken = payload.access_token;
      const newRefreshToken = payload.refresh_token;
  
      if (!newAccessToken) {
        throw new Error('刷新成功但未返回 access_token');
      }
  
      this.accessToken = newAccessToken;
      if (newRefreshToken) this.refreshToken = newRefreshToken;
  
      // 记录刷新时间（给防抖用）
      this._lastRefreshAt = Date.now();
  
      // ✅ 通知外层写回 config.json（如果你配置了回调）
      if (typeof this.onAuthUpdate === 'function') {
        await this.onAuthUpdate({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken
        });
      }
  
      this.logger.log('[API] refreshAccessToken: 刷新成功');
      return { accessToken: this.accessToken, refreshToken: this.refreshToken };
    })();
  
    // ✅ 无论成功失败都要清理锁，避免卡死
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  applyAuthToHeaders(headers = {}) {
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    else delete headers.Authorization;
    return headers;
  }

  async requestWithAutoRefresh(config) {
    try {
      // 每次发请求前都用当前 accessToken 覆盖 Authorization
      config.headers = this.applyAuthToHeaders({ ...(config.headers || {}) });

      const resp = await this.openClient.request(config);
  
      // 业务层错误（115 这种常用 response.data.state）
      if (resp?.data?.state === false && (resp.data.code === 40140125 || resp.data.code === 40140126)) {
        this.logger.warn('[API] access_token 无效，准备刷新并重试一次');
  
        await this.refreshAccessToken();          // ✅ singleflight 刷新
  
        // ✅ 重试一次（避免死循环：加标记）
        if (!config.__retried) {
          const retryConfig = { 
            ...config,
            __retried: true,
            headers: this.applyAuthToHeaders({ ...(config.headers || {}) }) // ✅ 重试前再覆盖一次
          };
          return await this.openClient.request(retryConfig);
        }
      }
  
      return resp;
    } catch (err) {
      // 如果是 HTTP 401 这种，也可以在这里触发刷新（按你的接口情况）
      throw err;
    }
  }
  

  /**
   * 获取文件下载链接
   * @param {string} fileId - 文件ID
   * @param {string} pickcode - 文件pickcode
   * @param {string} clientUserAgent - WebDAV客户端的User-Agent（可选）
   * @returns {Promise<Object>} 包含url和userAgent的对象
   */
  async getDownloadUrl(fileId, pickcode, clientUserAgent = null) {
    try {
      this.logger.log(`[API] 获取下载链接 - fileId: ${fileId}, pickcode: ${pickcode}`);
      
      // 如果传入了客户端的User-Agent，使用它来覆盖默认的
      const userAgentToUse = clientUserAgent || this.userAgent;
      if (clientUserAgent) {
        this.logger.log(`[API] 使用客户端传入的User-Agent: ${clientUserAgent}`);
      }

      // ✅ 缓存 key：fileId + pickcode + UA
      const cacheKey = `${String(fileId)}|${String(pickcode)}|${userAgentToUse}`;

      // ✅ 命中缓存
      const cached = this._downloadUrlCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        this.logger.log(`[API] 下载链接命中缓存 - key: ${cacheKey}`);
        return cached.value;
      } else if (cached) {
        this._downloadUrlCache.delete(cacheKey);
      }

      // ✅ 合并并发：同 key 正在请求就复用
      const inflight = this._downloadUrlInflight.get(cacheKey);
      if (inflight) {
        this.logger.log(`[API] 下载链接合并并发请求 - key: ${cacheKey}`);
        return inflight;
      }

      const p = this._downloadLimiter.run(async () => {
        // 使用115开放API获取下载链接
        const formData = new FormData();
        formData.append('pick_code', pickcode);

        const headers = { ...formData.getHeaders() };
        headers['User-Agent'] = userAgentToUse;

        const response = await this.requestWithAutoRefresh({
          method: 'POST',
          url: '/open/ufile/downurl',
          data: formData,
          headers
        });

        this.logger.log(`[API] 下载链接响应 - state: ${response.data?.state}, code: ${response.data?.code || 'N/A'}`);

        // 检查响应状态
        if (!response.data) {
          throw new Error('API响应为空');
        }

        if (response.data.state === false) {
          const errorMsg = response.data.message || `API错误 (code: ${response.data.code || 'unknown'})`;
          throw new Error(errorMsg);
        }

        // 解析响应数据
        // data 是一个对象，key 是文件ID（字符串格式），value 包含 url 信息
        const data = response.data.data || {};
        
        if (Object.keys(data).length === 0) {
          throw new Error('响应数据为空');
        }
        
        // 查找对应的文件ID（确保类型一致，都转为字符串比较）
        const fileIdStr = String(fileId);
        let fileData = null;
        
        // 优先使用传入的 fileId 查找
        if (data[fileIdStr]) {
          fileData = data[fileIdStr];
        } else {
          // 如果找不到，尝试遍历所有key（可能ID格式不完全匹配）
          const keys = Object.keys(data);
          for (const key of keys) {
            if (key === fileIdStr || key === String(fileId)) {
              fileData = data[key];
              break;
            }
          }
          
          // 如果还是找不到，使用第一个文件的数据（作为后备方案）
          if (!fileData && keys.length > 0) {
            fileData = data[keys[0]];
            console.warn(`未找到文件ID ${fileIdStr}，使用返回的第一个文件: ${keys[0]}`);
          }
        }

        if (!fileData) {
          throw new Error('响应中未找到文件数据');
        }

        if (!fileData.url || !fileData.url.url) {
          throw new Error('文件数据中未找到下载链接');
        }

        const downloadUrl = fileData.url.url;
        this.logger.log(`[API] 成功获取下载链接: ${downloadUrl.substring(0, 100)}...`);
        this.logger.log(`[API] 返回的User-Agent: ${userAgentToUse}`);
        
        // 返回下载链接和User-Agent，确保访问时使用相同的UA
        const result = { url: downloadUrl, userAgent: userAgentToUse };
        // ✅ 写入缓存（60s）
        this._downloadUrlCache.set(cacheKey, {
          expiresAt: Date.now() + this.downloadUrlTtlMs,
          value: result
        });
        return result;
      });
      this._downloadUrlInflight.set(cacheKey, p);
      try {
        return await p;
      } finally {
        this._downloadUrlInflight.delete(cacheKey);
      }
    } catch (error) {
      this.logger.error('获取下载链接失败:', error.message);
      if (error.response) {
        this.logger.error('API响应:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * 搜索文件/文件夹
   * @param {string} keyword - 搜索关键词
   * @param {string} fileId - 在指定文件夹内搜索
   * @returns {Promise<Array>}
   */
  async search(keyword, fileId = '0') {
    try {
      this.logger.log(`[API] 搜索文件 - keyword: ${keyword}, fileId: ${fileId}`);
      const response = await this.client.get('/files/search', {
        params: {
          aid: 1,
          cid: fileId,
          search_value: keyword,
          offset: 0,
          limit: 100
        }
      });

      if (response.data && response.data.state !== false && response.data.data) {
        const files = this.formatFileList(response.data);
        this.logger.log(`[API] 搜索结果数量: ${files.length}`);
        return files;
      }
      return [];
    } catch (error) {
      this.logger.error('搜索失败:', error.message);
      throw error;
    }
  }

  /**
   * 根据路径获取文件信息
   * @param {string} path - 文件路径
   * @returns {Promise<Object|null>}
   */
  async getFileByPath(path) {
    this.logger.log(`[API] 根据路径获取文件 - path: ${path}`);
    const parts = path.split('/').filter(p => p);
    let currentId = '0';
    let currentPath = '';

    for (const part of parts) {
      this.logger.log(`[API] 查找路径部分: ${part}, 当前目录ID: ${currentId}`);
      const files = await this.getFileList(currentId);
      const found = files.find(f => f.name === part);
      
      if (!found) {
        this.logger.log(`[API] 未找到路径部分: ${part}`);
        return null;
      }

      if (found.type === 'file' && part === parts[parts.length - 1]) {
        this.logger.log(`[API] 找到文件: ${found.name}, ID: ${found.id}`);
        return found;
      }

      if (found.type === 'directory') {
        currentId = found.id;
        currentPath += `/${found.name}`;
        this.logger.log(`[API] 进入目录: ${found.name}, 新目录ID: ${currentId}`);
      } else {
        this.logger.log(`[API] 路径部分不是目录: ${part}`);
        return null;
      }
    }

    // 如果是目录路径
    if (parts.length > 0) {
      const files = await this.getFileList(currentId);
      return {
        id: currentId,
        name: parts[parts.length - 1],
        type: 'directory',
        size: 0,
        mtime: Date.now() / 1000,
        path: currentPath
      };
    }

    return null;
  }
}
