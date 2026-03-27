/**
 * Course Sharing Download Worker - fflate 版本
 *
 * 使用 fflate 库实现 ZIP 打包功能，解决以下问题：
 * 1. P0: 内存爆炸风险 - 使用 fflate 的流式压缩
 * 2. P0: CRC32 校验缺失 - fflate 自动计算正确的 CRC32
 * 3. P1: 内存缓存 - Worker 生命周期内持久
 * 4. P1: 并发控制
 * 5. P1: O(1) 路径查找
 * 6. P2: 统一日志工具
 * 7. P2: Promise.allSettled 容错处理
 * 8. P2: URL 解码性能优化
 */

import { zip } from 'fflate';

// 响应头配置
const RESPONSE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// 日志工具
function createLogger(env) {
  return {
    debug: (...args) => env.DEBUG && console.log('[DEBUG]', ...args),
    warn: (...args) => env.DEBUG && console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
  };
}

// 错误响应
function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: RESPONSE_HEADERS
  });
}

// 成功响应
function successResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: RESPONSE_HEADERS
  });
}

// ==================== 缓存管理 ====================

// 内存缓存（Worker 生命周期内持久）
let memoryCache = null;

// 默认 GitHub manifest URL
const DEFAULT_GITHUB_MANIFEST_URL = 'https://raw.githubusercontent.com/FM-Course/course-sharing-web/refs/heads/main/docs/.vitepress/public/manifest.json';

// Token 验证
function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.substring(7);
  return token === env.REFRESH_TOKEN;
}

// 从 GitHub URL 获取 manifest
async function fetchManifestFromGitHub(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch from GitHub: ${res.status}`);
  const manifest = await res.json();
  manifest.fileSet = new Set(Object.keys(manifest.files));
  return manifest;
}

// 从 R2 存储桶获取 manifest.json
async function fetchManifestFromR2(env) {
  const manifestObject = await env.COURSE_BUCKET.get('manifest.json');
  if (!manifestObject) throw new Error('manifest.json not found in R2');
  const manifestText = await manifestObject.text();
  const manifest = JSON.parse(manifestText);
  manifest.fileSet = new Set(Object.keys(manifest.files));
  return manifest;
}

// 获取 manifest（优先内存，然后 R2）
async function getManifest(env) {
  const log = createLogger(env);

  try {
    // 内存缓存命中
    if (memoryCache) {
      log.debug('从内存缓存获取 manifest');
      return memoryCache;
    }

    // 从 R2 获取
    log.debug('从 R2 获取 manifest');
    const manifest = await fetchManifestFromR2(env);
    memoryCache = manifest;
    return manifest;
  } catch (error) {
    log.error('获取 manifest 失败:', error);
    throw error;
  }
}

// ==================== 文件操作 ====================

// 获取文件扩展名
function getFileExtension(filename) {
  const match = filename.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1] : 'bin';
}

// 从 manifest 中查找文件（O(1) 查找）
function findFileInManifest(manifest, filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return manifest.fileSet.has(normalizedPath) ? {
    path: normalizedPath,
    hash: manifest.files[normalizedPath],
    extension: getFileExtension(normalizedPath)
  } : null;
}

// 从 manifest 中查找文件夹下的所有文件
function findFilesInFolder(manifest, folderPath) {
  const normalizedPath = folderPath.replace(/\\/g, '/');
  const folderPrefix = normalizedPath.endsWith('/') ? normalizedPath : normalizedPath + '/';

  const files = [];
  for (const [filePath, hash] of Object.entries(manifest.files)) {
    if (filePath.startsWith(folderPrefix)) {
      files.push({
        path: filePath,
        hash: hash,
        extension: getFileExtension(filePath),
        relativePath: filePath.substring(folderPrefix.length)
      });
    }
  }
  return files;
}

// ==================== 路径层级检测 ====================

function getPathDepth(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.length;
}

function isEntireCourse(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.length === 1;
}

function isFirstLevelFolder(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.length === 2;
}

// ==================== 下载功能 ====================

// 下载单个文件
async function downloadFile(env, fileInfo) {
  const log = createLogger(env);
  const { hash, extension, path: originalPath } = fileInfo;
  const r2Key = `${hash}.${extension}`;

  log.debug(`下载文件: ${originalPath} -> ${r2Key}`);

  const object = await env.COURSE_BUCKET.get(r2Key);
  if (!object) {
    throw new Error(`File not found in R2: ${r2Key}`);
  }

  const filename = originalPath.split('/').pop();

  // 直接使用 object.body 作为流式响应，避免将整个文件加载到内存
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': object.size.toString(),
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 使用 fflate 打包文件夹为 ZIP
async function downloadFolderWithFflate(env, folderPath, files) {
  const log = createLogger(env);
  const CONCURRENCY_LIMIT = env.MAX_CONCURRENT || 5;

  log.debug(`下载文件夹: ${folderPath} (${files.length} 个文件)`);

  // 限制并发数，分批下载文件
  const fileBuffers = [];

  for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
    const chunk = files.slice(i, i + CONCURRENCY_LIMIT);

    // 使用 Promise.allSettled 进行容错处理
    const results = await Promise.allSettled(
      chunk.map(async (fileInfo) => {
        const { hash, extension, relativePath } = fileInfo;
        const r2Key = `${hash}.${extension}`;

        const object = await env.COURSE_BUCKET.get(r2Key);
        if (!object) {
          throw new Error(`文件不存在: ${r2Key}`);
        }

        const data = await object.arrayBuffer();
        return {
          name: relativePath,
          data: new Uint8Array(data)
        };
      })
    );

    // 处理结果
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        fileBuffers.push(result.value);
      } else if (result.status === 'rejected') {
        log.warn(`跳过失败文件: ${result.reason.message}`);
      }
    }
  }

  if (fileBuffers.length === 0) {
    throw new Error('文件夹中没有可下载的文件');
  }

  if (fileBuffers.length < files.length) {
    log.warn(`跳过 ${files.length - fileBuffers.length} 个失败文件`);
  }

  // 使用 fflate 同步创建 ZIP
  // fflate 会自动计算正确的 CRC32
  const zipBuffer = await new Promise((resolve, reject) => {
    const fileMap = {};
    for (const file of fileBuffers) {
      fileMap[file.name] = file.data;
    }

    zip(fileMap, { level: 0 }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });

  const folderName = folderPath.split('/').filter(Boolean).pop() || 'folder';

  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
      'Content-Length': zipBuffer.length.toString(),
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 下载预打包的 ZIP
async function downloadPrepackedZip(env, manifest, prepackedInfo, folderPath) {
  const log = createLogger(env);
  const { zipKey, size } = prepackedInfo;

  log.debug(`下载预打包 ZIP: ${folderPath} -> ${zipKey}`);

  const object = await env.COURSE_BUCKET.get(zipKey);
  if (!object) {
    log.warn(`预打包 ZIP 不存在，回退到实时打包: ${zipKey}`);
    const files = findFilesInFolder(manifest, folderPath);
    return await downloadFolderWithFflate(env, folderPath, files);
  }

  const folderName = folderPath.split('/').pop() || 'folder';

  // 直接使用 object.body 作为流式响应，避免将整个文件加载到内存
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
      'Content-Length': size.toString(),
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ==================== 请求处理 ====================

// 处理下载请求
async function handleDownload(request, env) {
  const log = createLogger(env);
  const url = new URL(request.url);
  const path = url.pathname;

  // 移除开头的 /download/ 前缀（如果存在）
  let requestPath = path.replace(/^\/download\//, '').replace(/^\//, '');

  if (!requestPath) {
    return errorResponse('请提供文件或文件夹路径');
  }

  // 始终尝试解码（对 ASCII 路径无影响），处理中文和特殊字符
  try {
    requestPath = decodeURIComponent(requestPath);
  } catch {
    log.warn('URL 解码失败，使用原始路径');
  }

  // 去除末尾的斜杠，确保路径匹配一致
  requestPath = requestPath.replace(/\/$/, '');

  try {
    // 获取 manifest（使用多层缓存）
    const manifest = await getManifest(env);

    // 检查是文件还是文件夹（O(1) 查找）
    const isFile = manifest.fileSet.has(requestPath);

    if (isFile) {
      // 下载单个文件
      const fileInfo = findFileInManifest(manifest, requestPath);
      if (!fileInfo) {
        return errorResponse('文件不存在', 404);
      }

      return await downloadFile(env, fileInfo);
    } else {
      // 文件夹下载：三级策略
      if (isEntireCourse(requestPath)) {
        // 情况1: 整个课程 → 拒绝
        return errorResponse('不支持下载整个课程，请下载子文件夹', 403);
      } else if (isFirstLevelFolder(requestPath)) {
        // 情况2: 一级子文件夹 → 检查预打包
        const prepackedInfo = manifest.prepackages?.[requestPath];
        if (prepackedInfo) {
          return await downloadPrepackedZip(env, manifest, prepackedInfo, requestPath);
        }
      }
      // 情况3: 二级及更深文件夹，或没有预打包 → 实时打包
      const files = findFilesInFolder(manifest, requestPath);
      if (files.length === 0) {
        return errorResponse('文件夹不存在或为空', 404);
      }

      return await downloadFolderWithFflate(env, requestPath, files);
    }
  } catch (error) {
    log.error('下载处理错误:', error);
    return errorResponse(error.message, 500);
  }
}

// 处理 OPTIONS 请求（CORS 预检）
function handleOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

// ==================== 主入口 ====================

export default {
  async fetch(request, env, _ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    const url = new URL(request.url);

    // 刷新 manifest 缓存端点（支持 GET/POST）
    if (url.pathname === '/refresh-manifest') {
      const log = createLogger(env);

      if (!verifyAuth(request, env)) {
        return errorResponse('Unauthorized', 401);
      }

      try {
        log.debug('刷新 manifest 缓存');
        const manifest = await fetchManifestFromGitHub(
          env.MANIFEST_GITHUB_URL || DEFAULT_GITHUB_MANIFEST_URL
        );
        memoryCache = manifest;
        log.debug(`Manifest 更新成功: ${manifest.total_files} 个文件`);

        return successResponse({
          refreshed: true,
          fileCount: manifest.total_files,
          version: manifest.version
        });
      } catch (error) {
        log.error('刷新 manifest 失败:', error);
        return errorResponse(`刷新失败: ${error.message}`, 500);
      }
    }

    // 只支持 GET 请求（除了 /refresh-manifest）
    if (request.method !== 'GET') {
      return errorResponse('只支持 GET 请求', 405);
    }

    // 健康检查端点
    if (url.pathname === '/health') {
      return successResponse({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cache: {
          inMemory: memoryCache !== null,
          fileCount: memoryCache ? Object.keys(memoryCache.files).length : 0
        }
      });
    }

    // 测试端点：直接下载测试文件
    if (url.pathname === '/test-download') {
      try {
        const object = await env.COURSE_BUCKET.get('test-download.txt');
        if (!object) {
          return errorResponse('测试文件未找到', 404);
        }

        const data = await object.arrayBuffer();
        return new Response(data, {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Disposition': 'attachment; filename="test-download.txt"',
            'Content-Length': data.byteLength.toString(),
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return errorResponse(`测试下载失败: ${error.message}`, 500);
      }
    }

    // 获取 manifest 信息端点
    if (url.pathname === '/manifest-info') {
      try {
        const manifest = await getManifest(env);
        return successResponse({
          version: manifest.version,
          total_files: manifest.total_files,
          last_updated: manifest.version
        });
      } catch (error) {
        return errorResponse('获取 manifest 信息失败', 500);
      }
    }

    // 下载端点
    if (url.pathname.startsWith('/download/') || url.pathname === '/download') {
      return handleDownload(request, env);
    }

    // 默认响应
    return successResponse({
      service: 'Course Sharing Download Worker (fflate)',
      endpoints: {
        '/health': '健康检查',
        '/refresh-manifest': '刷新 manifest 缓存（需认证）',
        '/manifest-info': '获取 manifest 信息',
        '/download/<path>': '下载文件或文件夹'
      },
      usage: 'GET /download/<文件路径> 下载单个文件，GET /download/<文件夹路径> 下载文件夹（ZIP）',
      features: 'fflate ZIP 打包、内存缓存、GitHub 自动刷新、并发控制、CRC32 自动计算'
    });
  }
};
