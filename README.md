# Course Sharing Download Worker

Cloudflare Worker 用于从 R2 存储桶下载课程文件。

## 功能特性

1. **单个文件下载**：通过文件路径下载单个文件，自动恢复原始文件名
2. **文件夹下载**：下载整个文件夹，自动打包为 zip 格式
3. **manifest 缓存**：使用 KV 缓存 manifest.json 提高性能
4. **CORS 支持**：完全支持跨域请求
5. **健康检查**：提供健康检查端点

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Cloudflare

```bash
# 登录 Cloudflare
wrangler login

# 创建 KV 命名空间（用于缓存 manifest）
wrangler kv:namespace create "MANIFEST_CACHE"
# 记下返回的 ID，更新 wrangler.toml 中的 id

# 创建 R2 存储桶绑定（如果尚未创建）
# 确保名为 "fm-course-sharing" 的 R2 存储桶已存在
```

### 3. 更新配置文件

编辑 `wrangler.toml`：
- 更新 `kv_namespaces.id` 为实际的 KV 命名空间 ID
- 更新 `routes` 为你的域名
- 更新 `vars.MANIFEST_URL` 为实际的 manifest.json URL

### 4. 部署 Worker

```bash
# 开发模式
npm run dev

# 部署到生产环境
npm run deploy
```

## API 端点

### 健康检查
```
GET /health
```
返回服务状态。

### Manifest 信息
```
GET /manifest-info
```
返回 manifest.json 的基本信息。

### 文件下载
```
GET /download/<文件路径>
```
下载单个文件。例如：
- `/download/Advanced-Financial-Mathematics/Assignments-2025spring/FM2_A1_Sol.pdf`

### 文件夹下载
```
GET /download/<文件夹路径>
```
下载整个文件夹（打包为 tar）。例如：
- `/download/Advanced-Financial-Mathematics/Assignments-2025spring/`

## 使用示例

### 下载单个文件（JavaScript）

```javascript
async function downloadFile(filePath) {
  const response = await fetch(`https://your-worker.domain/download/${filePath}`);

  if (!response.ok) {
    throw new Error(`下载失败: ${response.status}`);
  }

  // 获取文件名（从 Content-Disposition 头）
  const contentDisposition = response.headers.get('Content-Disposition');
  const filename = contentDisposition.match(/filename="(.+)"/)[1];

  // 下载文件
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = decodeURIComponent(filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
```

### 下载文件夹（JavaScript）

```javascript
async function downloadFolder(folderPath) {
  const response = await fetch(`https://your-worker.domain/download/${folderPath}`);

  if (!response.ok) {
    throw new Error(`下载失败: ${response.status}`);
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${folderPath.split('/').filter(Boolean).pop() || 'folder'}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
```

## 前端集成

在前端页面中添加下载按钮：

```html
<!-- 单个文件下载 -->
<button onclick="downloadFile('Advanced-Financial-Mathematics/Assignments-2025spring/FM2_A1_Sol.pdf')">
  下载文件
</button>

<!-- 文件夹下载 -->
<button onclick="downloadFolder('Advanced-Financial-Mathematics/Assignments-2025spring')">
  下载文件夹
</button>
```

## 文件命名规则

R2 存储桶中的文件使用以下命名规则：
```
<SHA256哈希值>.<扩展名>
```

例如：
```
004bff019ff83de3c8e1e405e43a1030a3d3ac402c4bb042137e6b841cdfeda5.pdf
```

Worker 会根据 manifest.json 中的映射关系，将原始文件名恢复。

## 注意事项

1. **manifest.json 同步**：确保 R2 存储桶中的 manifest.json 是最新的
2. **文件权限**：R2 存储桶需要设置为公开可读（或通过 Worker 访问）
3. **缓存策略**：manifest.json 默认缓存 1 小时，可通过环境变量调整
4. **文件大小限制**：Cloudflare Worker 有响应大小限制（约 100MB）

## 故障排除

### 文件找不到
1. 检查 manifest.json 是否存在于 R2 存储桶
2. 检查文件路径是否正确（使用正斜杠）
3. 检查 R2 存储桶中是否存在对应的哈希文件

### 下载失败
1. 检查 Worker 日志：`wrangler tail`
2. 检查 CORS 配置
3. 检查网络连接

### 性能问题
1. 增加 KV 缓存时间
2. 考虑使用 Cloudflare CDN 缓存
3. 优化 manifest.json 大小
