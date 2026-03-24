# 下载Worker部署指南

## 概述

这个Cloudflare Worker负责从R2存储桶下载课程文件。它支持：
1. 单个文件下载（恢复原始文件名）
2. 文件夹下载（打包为zip格式，使用 fflate 库）
3. manifest.json 内存缓存 + GitHub 自动刷新
4. 并发控制（R2 下载并发限制）
5. 正确的 CRC32 校验（fflate 自动计算）

## 技术特性

| 特性 | 说明 |
|------|------|
| ZIP 打包 | 使用 fflate 库，自动计算正确 CRC32 |
| 内存缓存 | Worker 生命周期内持久，无 TTL |
| GitHub 自动刷新 | 前端 push 后自动更新缓存 |
| 并发控制 | 默认 5 并发下载，防止 R2 限流 |
| 路径查找 | O(1) Set 查找，提升大文件量性能 |
| 中文支持 | 完整 URL 解码，支持中文路径 |

## 部署步骤

### 1. 准备工作

确保你已经：
- 安装Node.js (>=18.0.0)
- 安装wrangler CLI: `npm install -g wrangler`
- 有Cloudflare账户并已登录: `wrangler login`

### 2. 配置R2存储桶

确保R2存储桶 `fm-course-sharing` 已存在并包含：
- 课程文件（命名格式：`<SHA256>.<扩展名>`）
- manifest.json文件（由上传脚本生成）

### 3. 更新配置文件

编辑 `wrangler.toml`：

```toml
# 更新路由（使用你的域名）
routes = [
  { pattern = "download.your-domain.com/*", zone_name = "your-domain.com" }
]

# 环境变量
[vars]
DEBUG = "false"           # 开启调试日志（生产环境设为 false）
MAX_CONCURRENT = "5"      # R2 并发下载数
REFRESH_TOKEN = ""        # 刷新 manifest 缓存的认证 token（部署后在 Cloudflare Dashboard 设置）
MANIFEST_GITHUB_URL = "https://raw.githubusercontent.com/FM-Course/course-sharing-web/refs/heads/main/docs/.vitepress/public/manifest.json"
```

### 4. 配置刷新 Token（重要！）

1. 生成一个随机 Token（建议使用强密码生成器）
2. 在 Cloudflare Dashboard → Workers & Pages → Settings → Variables 中设置：
   - `REFRESH_TOKEN`: 你的随机 Token
   - `MANIFEST_GITHUB_URL`: GitHub raw 链接（可选，有默认值）
3. 在前端仓库的 GitHub Secrets 中设置：
   - `REFRESH_TOKEN`: 相同的随机 Token
   - `WORKER_URL`: Worker 的完整 URL（如 `https://course-sharing-download.your-account.workers.dev`）

### 5. 安装依赖

```bash
cd /home/jinsui/CourseSharing/worker
npm install
```

### 6. 配置 GitHub Actions

在前端仓库添加工作流（已在 `frontend/.github/workflows/refresh-manifest.yml`）：

```yaml
name: Refresh Manifest Cache

on:
  push:
    branches: [main]
    paths:
      - 'docs/.vitepress/public/manifest.json'

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Worker refresh
        env:
          WORKER_URL: ${{ secrets.WORKER_URL }}
          REFRESH_TOKEN: ${{ secrets.REFRESH_TOKEN }}
        run: |
          curl -X POST \
            -H "Authorization: Bearer $REFRESH_TOKEN" \
            "$WORKER_URL/refresh-manifest"
```

### 7. 测试本地开发

```bash
# 启动本地开发服务器
npm run dev

# 在另一个终端测试
node test-download.js
```

### 8. 部署到生产环境

```bash
# 部署Worker
npm run deploy

# 输出示例：
# ⛅️ wrangler 3.0.0
# ✨ Successfully published your script to
# https://course-sharing-download.your-account.workers.dev
```

### 9. 配置自定义域名（可选）

```bash
# 添加自定义域名
wrangler route create download.your-domain.com/* --name course-sharing-download
```

## 工作流程

### 完整更新流程

1. **更新课程内容**：在 `content/` 目录中添加/修改文件
2. **生成manifest和前端信息**：
   ```bash
   cd /home/jinsui/CourseSharing/update
   npm run update-frontend
   ```
3. **上传文件到R2**：
   ```bash
   npm run upload
   ```
4. **上传manifest到R2**：
   ```bash
   npm run upload-manifest
   ```
   *或者使用组合命令：*
   ```bash
   npm run update-and-upload
   ```

### 简化流程

使用单个命令完成所有操作：
```bash
cd /home/jinsui/CourseSharing/update
npm run update-and-upload
```

这个命令会：
1. 生成manifest.json和course-info.json
2. 上传新增/修改的文件到R2
3. 上传manifest.json到R2（供下载Worker使用）

## API使用示例

### 前端JavaScript代码

```javascript
// 下载单个文件
async function downloadFile(filePath) {
  const workerUrl = 'https://download.your-domain.com';
  const response = await fetch(`${workerUrl}/download/${filePath}`);

  if (!response.ok) {
    throw new Error(`下载失败: ${response.status}`);
  }

  // 获取文件名
  const contentDisposition = response.headers.get('Content-Disposition');
  const filenameMatch = contentDisposition.match(/filename="(.+)"/);
  const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : 'download';

  // 创建下载链接
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

// 下载文件夹
async function downloadFolder(folderPath) {
  const workerUrl = 'https://download.your-domain.com';
  const response = await fetch(`${workerUrl}/download/${folderPath}`);

  if (!response.ok) {
    throw new Error(`下载失败: ${response.status}`);
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  // 从文件夹路径提取名称
  const folderName = folderPath.split('/').filter(Boolean).pop() || 'folder';
  a.download = `${folderName}.zip`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

// 使用示例
downloadFile('Advanced-Financial-Mathematics/Assignments-2025spring/FM2_A1_Sol.pdf');
downloadFolder('Advanced-Financial-Mathematics/Assignments-2025spring');
```

### 直接URL访问

- 单个文件：`https://download.your-domain.com/download/文件路径`
- 文件夹：`https://download.your-domain.com/download/文件夹路径/`

## 监控和日志

### 查看Worker日志

```bash
# 实时查看日志
wrangler tail

# 查看特定时间段的日志
wrangler tail --format pretty --since 1h
```

### 健康检查

访问：`https://download.your-domain.com/health`

### Manifest信息

访问：`https://download.your-domain.com/manifest-info`

### 手动刷新缓存

```bash
# 使用 curl 手动刷新（需要正确的 Token）
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  https://download.your-domain.com/refresh-manifest
```

## 故障排除

### 常见问题

1. **文件找不到**
   - 检查manifest.json是否已上传到R2
   - 检查文件路径是否正确
   - 检查R2中是否存在对应的哈希文件

2. **下载Worker返回错误**
   - 查看Worker日志：`wrangler tail`
   - 检查R2存储桶绑定
   - 检查R2存储桶绑定

3. **CORS错误**
   - 确保前端域名在CORS允许列表中
   - 检查响应头是否正确设置

4. **性能问题**
   - 重新部署 Worker 以刷新内存缓存
   - 考虑使用Cloudflare CDN缓存
   - 优化manifest.json大小

### 调试步骤

1. 检查本地开发：
   ```bash
   npm run dev
   node test-download.js
   ```

2. 检查生产环境：
   ```bash
   curl https://download.your-domain.com/health
   curl https://download.your-domain.com/manifest-info
   ```

3. 检查R2存储桶：
   ```bash
   wrangler r2 object list fm-course-sharing --remote
   wrangler r2 object get fm-course-sharing/manifest.json --pipe --remote
   ```

## 安全考虑

1. **访问控制**：
   - Worker默认公开访问
   - 如需限制访问，可添加认证中间件

2. **速率限制**：
   - Cloudflare自动提供基础DDoS防护
   - 可配置Worker速率限制

3. **文件大小限制**：
   - Worker响应大小限制约100MB
   - 大文件建议分块下载

4. **缓存策略**：
   - manifest.json 使用内存缓存（Worker 生命周期内持久）
   - 重新部署 Worker 会刷新缓存

## 更新和维护

### 更新Worker代码

```bash
cd /home/jinsui/CourseSharing/worker
git pull  # 如果有版本控制
npm run deploy
```

### 更新manifest.json

每次课程内容更新后：
```bash
cd /home/jinsui/CourseSharing/update
npm run upload-manifest
```

**自动刷新机制**：前端仓库 push manifest.json 到 main 分支后，GitHub Actions 会自动调用 Worker 的 `/refresh-manifest` 端点更新内存缓存，无需重新部署 Worker。

### 清理旧文件

定期清理R2中的旧文件（通过哈希去重，通常不需要手动清理）。

## 性能优化建议

1. **CDN缓存**：配置Cloudflare CDN缓存静态文件
2. **ZIP 压缩级别**：当前使用 `level: 0`（不压缩），如需压缩可改为 `level: 6`
3. **并发数调整**：根据 R2 配额调整 `MAX_CONCURRENT`
4. **内存缓存**：Worker 重启时自动刷新
5. **监控**：使用Cloudflare Analytics监控使用情况

## 联系和支持

如有问题，请检查：
1. Worker日志：`wrangler tail`
2. Cloudflare仪表板
3. 项目文档

如需进一步帮助，请联系项目维护者。
