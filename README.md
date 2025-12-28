
# 115 WebDAV Server (Node.js)

这是一个为 **OpenList 的 STRM** 场景准备的轻量 WebDAV 服务：  
通过 115 网盘 API 获取目录/文件信息，并在下载时返回 **302 重定向到 115 直链**，从而减少中间层读取开销，**提升 Emby 等媒体服务器的起播速度**。

> 典型用法：OpenList 生成/管理 STRM → Emby 播放 STRM → 本服务负责把“文件访问”快速转到 115 直链。
> 支持：目录列表缓存、下载直链缓存、请求限流/并发合并（降低风控）、手动刷新目录。

---

## 功能概览

- WebDAV 基本能力
  - `PROPFIND`：列目录/文件属性（返回 `207 Multi-Status` XML）
  - `GET`：文件下载（302 重定向到 115 下载链接）
  - `HEAD`：文件元信息（Content-Length / Last-Modified / Content-Type）
  - `OPTIONS`：声明支持的 WebDAV 能力
- 115 API 侧优化（降低风控/提升体验）
  - 目录列表缓存：`cid -> files`（TTL 可配置）
  - 下载直链缓存：`fileId + pickcode + UA`（TTL 可配置）
  - 单飞锁合并并发：同目录/同文件直链并发请求合并为一次
  - 请求限流：控制 `getFileList` 并发和最小间隔
  - accessToken 自动刷新：请求遇到 `40140125` 自动刷新并重试一次
- 管理接口
  - 手动刷新目录缓存：`GET /__refresh?path=...&prefetch=1`

---

### Docker 运行（挂载 config.json）

```bash
docker run -d \
  --name openlist-115-strm-accelerator \
  -p 3000:3000 \
  -v $(pwd)/config.json:/app/config.json:ro \
  ghcr.io/zhangyun199/openlist-115-strm-accelerator:latest
```

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 准备配置文件 `config.json`

首次运行如果项目内有生成逻辑，会自动生成 `config.json`（或你可以手动创建）。

示例：

```json
{
  "debug": true,
  "pan115": {
    "cookie": "YOUR_115_COOKIE",
    "userId": "",
    "baseURL": "https://webapi.115.com",
    "accessToken": "",
    "refreshToken": "",

    "listConcurrency": 1,
    "listMinIntervalMs": 400,

    "fileListTtlMs": 60000,
    "downloadUrlTtlMs": 60000
  },
  "webdav": {
    "port": 3000,
    "username": "admin",
    "password": "admin",
    "blockGoHttpClient": true
  }
}
```

字段说明见下方「配置说明」。

### 3) 启动

```bash
npm start
```

或（如果你有自定义脚本）：

```bash
node index.js
```

启动后访问：

* WebDAV 地址：`http://localhost:3000/`
* 用户名密码：`config.webdav.username / config.webdav.password`

---

## 配置说明（config.json）

### debug

* `debug: true/false`
  是否输出更多调试日志。

### pan115

* `cookie`（必填）：115 登录 cookie，用于获取目录列表等接口
* `userId`（可选）：部分接口可能需要
* `baseURL`：115 API base url，默认 `https://webapi.115.com`
* `accessToken / refreshToken`：用于 115 OpenAPI 下载直链接口（`/open/ufile/downurl`）

  * 若 accessToken 失效，服务会自动调用刷新接口并更新（可配合 `onAuthUpdate` 写回 config）

#### 风控相关（推荐保持保守）

* `listConcurrency`：目录列表请求并发（建议 `1` 起步）
* `listMinIntervalMs`：目录列表请求启动最小间隔（建议 `300~600`）

#### 缓存相关

* `fileListTtlMs`：目录列表缓存 TTL（毫秒）

  * 数值越大越省请求，但新上传内容出现会更慢（可用手动刷新）
* `downloadUrlTtlMs`：下载链接缓存 TTL（毫秒）

  * 若发现链接有效期更短，可调低（例如 10~30 秒）

### webdav

* `port`：监听端口
* `username/password`：Basic Auth 账号密码
* `blockGoHttpClient`：是否拦截 `Go-http-client/1.1`（返回 403）

  * 用于避免openlist(strm)探测时获取下载链接

---

## 手动刷新目录（非常推荐）

目录列表有缓存（默认 60s），如果你在 WebDAV 之外（115 网页/客户端）上传了新文件，希望立刻在 WebDAV 里显示，可以手动刷新：

* 仅清缓存：

  * `GET /__refresh?path=/影视文件`
* 清缓存并预热（推荐，下一次 PROPFIND 立刻是新列表）：

  * `GET /__refresh?path=/影视文件&prefetch=1`

示例（浏览器会弹 Basic Auth）：

```
http://localhost:3000/__refresh?path=%2F%E5%BD%B1%E8%A7%86%E6%96%87%E4%BB%B6&prefetch=1
```

示例（curl）：

```bash
curl -u admin:admin "http://localhost:3000/__refresh?path=%2F%E5%BD%B1%E8%A7%86%E6%96%87%E4%BB%B6&prefetch=1"
```

---

## 常见问题

### 1) 为什么目录里看不到刚上传的新文件？

因为目录列表缓存 TTL 没过期。解决：

* 等 TTL 到期；或
* 调用 `/__refresh?path=...&prefetch=1` 立即刷新。

### 2) 访问某些路径时仍然显示根目录？

通常是路径规范化/编码问题。建议：

* 确保服务端统一使用 `decodeURIComponent` + 去掉末尾 `/` 的规范化方式
* 确保 WebDAV 响应中的 `<d:href>` 对中文/空格做了 URL 编码（encodeURIComponent）

### 3) 风控频繁怎么办？

从保守参数开始：

* `listConcurrency = 1`
* `listMinIntervalMs = 400~800`
* 缓存 TTL 适当加大（`fileListTtlMs`）

---

## 安全建议

* 如果你要在局域网/公网暴露服务：

  * 改掉默认账号密码
  * 建议只在内网使用或加一层反向代理/访问控制
* `cookie / accessToken / refreshToken` 属于敏感信息，请妥善保管。

---

## License

仅供学习与个人使用。请遵守 115 的服务条款与相关法律法规。
