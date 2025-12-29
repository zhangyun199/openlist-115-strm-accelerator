import express from 'express';
import { Logger } from './logger.js';

export class WebDAVServer {
  constructor(panAPI, options = {}) {
    this.panAPI = panAPI;

    this.port = options.port ?? 3000;
    this.username = options.username ?? 'admin';
    this.password = options.password ?? 'admin';

    this.blockGoHttpClient = options.blockGoHttpClient ?? false;

    this._refreshTimers = new Map(); // parentPath -> timeoutId

    this.logger = new Logger(!!options.debug);
    this.app = express();

    this.setupRoutes();
  }

  debounceRefreshDir(parentPath, delayMs = 300) {
    const p = parentPath === '/' ? '/' : parentPath.replace(/\/+$/g, '');
    const old = this._refreshTimers.get(p);
    if (old) clearTimeout(old);
  
    const t = setTimeout(async () => {
      this._refreshTimers.delete(p);
      try {
        // 失效父目录缓存
        this.panAPI.invalidateByPath?.(p);
  
        // 可选：预热（让下一次 PROPFIND 立刻拿到新列表）
        if (this.panAPI.refreshDirectoryByPath) {
          await this.panAPI.refreshDirectoryByPath(p);
        }
        this.logger.log(`[WebDAV] 已刷新父目录缓存: ${p}`);
      } catch (e) {
        this.logger.error(`[WebDAV] 刷新父目录失败: ${p}`, e);
      }
    }, delayMs);
  
    this._refreshTimers.set(p, t);
  }

  setupRoutes() {
    // 解析请求体（WebDAV 客户端可能会发 xml body）
    this.app.use(express.raw({ type: '*/*', limit: '10gb' }));
    this.app.use(express.text({ type: 'text/xml' }));

    // Basic Auth（全局）
    this.app.use(this.basicAuth());

    // 手动刷新（必须放在 GET * 之前）
    this.app.get('/__refresh', async (req, res) => {
      try {
        const raw = req.query.path ?? '/';
        const path = this.normalizeDecodedPath(String(raw));
        const prefetch = String(req.query.prefetch || '') === '1';

        this.logger.log(`[WebDAV] 手动刷新 - path=${path}, prefetch=${prefetch}`);

        if (prefetch) {
          const info = await this.panAPI.refreshDirectoryByPath(path);
          if (!info) return res.status(404).json({ ok: false, error: '目录不存在或不是目录' });
          return res.json({ ok: true, ...info, prefetch: true });
        }

        const id = this.panAPI.invalidateByPath(path);
        return res.json({ ok: true, path, invalidatedId: id ?? null, prefetch: false });
      } catch (e) {
        this.logger.error('[WebDAV] 手动刷新失败:', e);
        return res.status(500).json({ ok: false, error: e.message || 'Internal Error' });
      }
    });

    // PROPFIND
    this.app.use('/*', async (req, res, next) => {
      if (req.method !== 'PROPFIND') return next();

      try {
        const path = this.getRequestPath(req);
        const depth = req.headers.depth || '1';
        this.logger.log(`[WebDAV] PROPFIND - path=${path}, depth=${depth}`);

        const { type, items } = await this.resolvePathForListing(path);
        if (type === 'notfound') return res.status(404).send('Not Found');

        const xml = this.generatePropfindResponse(items, path, depth);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        return res.status(207).send(xml);
      } catch (e) {
        this.logger.error('[WebDAV] PROPFIND 错误:', e);
        return res.status(500).send('Internal Server Error');
      }
    });

    // MKCOL - 仅用于触发刷新，不实际创建
    this.app.use('/*', async (req, res, next) => {
      if (req.method !== 'MKCOL') return next();
    
      const fullPath = this.getRequestPath(req);
      const parentPath = fullPath.split('/').slice(0, -1).join('/') || '/';
    
      this.logger.log(`[WebDAV] MKCOL(fake) - path=${fullPath} -> 刷新 parent=${parentPath}`);
    
      this.debounceRefreshDir(parentPath, 300);
    
      return res.status(201).end();
    });
    
    // GET - 下载文件
    this.app.get('/*', async (req, res) => {
      try {
        const path = this.getRequestPath(req);
        this.logger.log(`[WebDAV] GET - path=${path}`);

        const file = await this.resolvePathToFile(path);
        if (!file) {
          this.logger.log(`[WebDAV] GET - 未找到: ${path}`);
          return res.status(404).send('Not Found');
        }
        if (file.type === 'directory') {
          this.logger.log(`[WebDAV] GET - 尝试下载目录: ${path}`);
          return res.status(405).send('Method Not Allowed');
        }

        const clientUserAgent = req.headers['user-agent'] || '';
        this.logger.log(`[WebDAV] GET - UA: ${clientUserAgent}`);

        if (this.blockGoHttpClient && clientUserAgent === 'Go-http-client/1.1') {
          this.logger.log('[WebDAV] 拦截 Go-http-client/1.1 -> 403');
          return res.status(403).send('Forbidden');
        }

        const downloadInfo = await this.panAPI.getDownloadUrl(file.id, file.pickcode, clientUserAgent);
        const downloadUrl = downloadInfo?.url || downloadInfo;

        this.logger.log(`[WebDAV] GET - 302 -> ${String(downloadUrl).substring(0, 120)}...`);
        return res.redirect(302, downloadUrl);
      } catch (e) {
        this.logger.error('[WebDAV] GET 错误:', e);
        return res.status(500).send('Internal Server Error');
      }
    });

    // HEAD - 文件信息
    this.app.head('/*', async (req, res) => {
      try {
        const path = this.getRequestPath(req);
        this.logger.log(`[WebDAV] HEAD - path=${path}`);

        const file = await this.resolvePathToFile(path);
        if (!file) return res.status(404).end();

        if (file.type === 'directory') {
          // 对目录 HEAD：很多客户端也会发，给个合理响应
          res.setHeader('Content-Type', 'httpd/unix-directory');
          return res.status(200).end();
        }

        res.setHeader('Content-Length', file.size ?? 0);
        res.setHeader('Last-Modified', new Date((file.mtime ?? Date.now()/1000) * 1000).toUTCString());
        res.setHeader('Content-Type', this.getContentType(file.name || ''));
        return res.status(200).end();
      } catch (e) {
        this.logger.error('[WebDAV] HEAD 错误:', e);
        return res.status(500).end();
      }
    });

    // OPTIONS
    this.app.options('/*', (req, res) => {
      const path = this.getRequestPath(req);
      this.logger.log(`[WebDAV] OPTIONS - path=${path}`);
      res.setHeader('DAV', '1, 2');
      res.setHeader('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
      return res.status(200).end();
    });

    // 其他方法
    this.app.use('/*', (req, res) => {
      if (!['OPTIONS', 'GET', 'HEAD', 'PROPFIND'].includes(req.method)) {
        return res.status(405).send('Method Not Allowed');
      }
      return res.status(404).send('Not Found');
    });
  }

  basicAuth() {
    return (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Basic ')) {
        this.logger.log(`[WebDAV] 认证失败 - 缺少 Authorization: ${req.method} ${req.originalUrl}`);
        res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
        return res.status(401).send('Unauthorized');
      }

      const credentials = Buffer.from(auth.substring(6), 'base64').toString('utf-8');
      const [username, password] = credentials.split(':');

      if (username !== this.username || password !== this.password) {
        this.logger.log(`[WebDAV] 认证失败 - 用户名或密码错误: ${req.method} ${req.originalUrl}`);
        res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
        return res.status(401).send('Unauthorized');
      }

      // debug 时再打印，避免刷屏
      this.logger.log(`[WebDAV] 认证成功 - user=${username}, ${req.method} ${req.originalUrl}`);
      next();
    };
  }

  // 从请求中拿“路径部分”（去 query、decode、去尾 /）
  getRequestPath(req) {
    const rawPath = (req.originalUrl || req.url || '/').split('?')[0];
    return this.normalizeDecodedPath(rawPath);
  }

  // decode + normalize（统一全项目使用这个作为 cache key）
  normalizeDecodedPath(raw) {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch {}
    // 统一多斜杠，去末尾斜杠（根目录除外）
    decoded = decoded.replace(/\/+/g, '/');
    if (decoded !== '/' && decoded.endsWith('/')) decoded = decoded.slice(0, -1);
    return decoded || '/';
  }

  // PROPFIND 列目录：返回 {type, items}
  async resolvePathForListing(path) {
    if (path === '/') {
      const items = await this.panAPI.getFileList('0');
      return { type: 'directory', items };
    }

    // 尽量走 Pan115API 的路径解析（建议你实现 resolveDirectoryIdByPath）
    if (typeof this.panAPI.resolveDirectoryIdByPath === 'function') {
      const dirId = await this.panAPI.resolveDirectoryIdByPath(path);
      if (dirId) {
        const items = await this.panAPI.getFileList(dirId);
        return { type: 'directory', items };
      }
    } else {
      // 退化：自己查 cache（必须使用同样 normalize 的 key）
      const cached = this.panAPI.pathToIdCache?.get(path);
      if (cached?.type === 'directory' && cached?.id) {
        const items = await this.panAPI.getFileList(cached.id);
        return { type: 'directory', items };
      }
    }

    // 不是目录时，看看是不是文件（depth:0 会走这里）
    const file = await this.panAPI.getFileByPath(path);
    if (!file) return { type: 'notfound', items: [] };
    return { type: file.type, items: file.type === 'directory' ? await this.panAPI.getFileList(file.id) : [file] };
  }

  // GET/HEAD：把路径解析成“单个文件对象”（目录也可能返回）
  async resolvePathToFile(path) {
    if (path === '/' || path === '') {
      return { id: '0', name: '/', type: 'directory', size: 0, mtime: Date.now() / 1000, path: '/' };
    }
    // 优先让 API 自己解析（它会利用缓存/限流）
    return await this.panAPI.getFileByPath(path);
  }

  // 生成 PROPFIND 响应
  generatePropfindResponse(items, basePath, depth) {
    const responses = [];

    // 当前目录的 href 必须以 / 结尾
    const currentHref = this.ensureTrailingSlash(this.encodeHrefPath(basePath));

    responses.push(this.generateFileResponse(currentHref, {
      type: 'directory',
      name: basePath === '/' ? '/' : basePath.split('/').filter(Boolean).pop() || '/',
      size: 0,
      mtime: Date.now() / 1000
    }));

    if (depth !== '0') {
      for (const file of items) {
        let p = basePath === '/' ? `/${file.name}` : `${basePath}/${file.name}`;
        if (file.type === 'directory') p = this.ensureTrailingSlash(p);

        const href = this.encodeHrefPath(p);
        responses.push(this.generateFileResponse(href, file));
      }
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
${responses.join('\n')}
</d:multistatus>`;
  }

  ensureTrailingSlash(p) {
    return p.endsWith('/') ? p : p + '/';
  }

  // 把路径段做 URL 编码（中文/空格/特殊字符），保留 /
  encodeHrefPath(path) {
    const p = path || '/';
    if (p === '/') return '/';
    return p
      .split('/')
      .map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg)))
      .join('/');
  }

  generateFileResponse(href, file) {
    const isDir = file.type === 'directory';

    const displayName = href === '/'
      ? '/'
      : decodeURIComponent((href.endsWith('/') ? href.slice(0, -1) : href).split('/').pop() || file.name || '/');

    const lastModified = new Date((file.mtime ?? Date.now() / 1000) * 1000).toUTCString();
    const contentLength = isDir ? '' : `<d:getcontentlength>${file.size ?? 0}</d:getcontentlength>`;
    const contentType = isDir ? '' : `<d:getcontenttype>${this.getContentType(file.name || '')}</d:getcontenttype>`;

    // WebDAV：目录 resourcetype 里带 collection
    const resourcetype = isDir ? '<d:collection/>' : '';

    return `  <d:response>
    <d:href>${this.escapeXml(href)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${this.escapeXml(displayName)}</d:displayname>
        <d:resourcetype>${resourcetype}</d:resourcetype>
        <d:getlastmodified>${lastModified}</d:getlastmodified>
        ${contentLength}
        ${contentType}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
  }

  escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  getContentType(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    const types = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      pdf: 'application/pdf',
      zip: 'application/zip',
      txt: 'text/plain'
    };
    return types[ext] || 'application/octet-stream';
  }

  start() {
    this.app.listen(this.port, () => {
      this.logger.info(`WebDAV服务器已启动: http://localhost:${this.port}`);
      this.logger.info(`用户名: ${this.username}`);
      this.logger.info(`密码: ${this.password}`);
      this.logger.info(`调试模式: ${this.logger.debug ? '开启' : '关闭'}`);
      this.logger.info(`拦截 Go-http-client/1.1: ${this.blockGoHttpClient ? '开启' : '关闭'}`);
    });
  }
}
