# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the worker component of this repository.

## Worker Overview

This is a Cloudflare Worker for downloading course files from R2 storage.

**Key Technologies:**
- Cloudflare Workers - Serverless edge runtime
- Cloudflare R2 - Object storage for course files
- fflate 0.8.2 - Streaming ZIP compression
- wrangler 4.76.0 - Deployment tooling

**Key Features:**
- Single file download with original filename restoration
- Folder download as ZIP using fflate library
- Manifest memory cache with GitHub auto-refresh
- Concurrency control for R2 downloads
- Automatic CRC32 checksum calculation
- O(1) path lookup with Set
- Full URL decoding for Chinese paths

## Directory Structure

```
worker/
├── src/
│   └── index.js           # Main Worker entry point
├── wrangler.toml          # Production configuration
├── wrangler-dev.toml      # Local development configuration
├── package.json
└── README.md
```

## Common Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local Worker dev server with persistence |
| `npm run deploy` | Deploy Worker to Cloudflare |
| `wrangler tail` | Stream Worker logs |
| `wrangler tail --format pretty --since 1h` | View logs from last hour |

## Key Files

### Source
- **`src/index.js`**: Main Worker with all functionality

### Configuration
- **`wrangler.toml`**: Production Cloudflare config (R2 binding, env vars)
- **`wrangler-dev.toml`**: Local development config

## Architecture & Features

### Caching Strategy
- **Memory cache**: In-memory cache for manifest (Worker lifecycle, no TTL)
- **R2 origin**: Fallback for manifest retrieval
- **GitHub auto-refresh**: Automatically updates cache after frontend push

### Download Strategy (Three-tier)
1. **Entire course**: Rejected (403) - must download subfolders
2. **First-level folders**: Check for pre-packaged ZIP, fallback to on-the-fly
3. **Deeper folders**: On-the-fly ZIP generation with fflate

### ZIP Generation
- Uses `fflate` for streaming compression (memory efficient)
- Automatic CRC32 checksums
- Concurrency control (default: 5 concurrent downloads)
- `Promise.allSettled` for fault tolerance
- Currently uses `level: 0` (no compression), can be adjusted

### API Endpoints

| Endpoint | Method | Description | Auth |
|----------|--------|-------------|------|
| `/` | GET | Service info | No |
| `/health` | GET | Health check | No |
| `/manifest-info` | GET | Manifest version info | No |
| `/download/<path>` | GET | Download file/folder | No |
| `/refresh-manifest` | GET/POST | Refresh manifest cache from GitHub | Yes |

### Authentication
- `/refresh-manifest` requires `Authorization: Bearer <REFRESH_TOKEN>`
- Token set via Cloudflare Dashboard env vars
- Same token must be set in frontend repo GitHub Secrets

### Environment Variables

| Var | Description | Default |
|-----|-------------|---------|
| `DEBUG` | Enable debug logging | `false` (prod) / `true` (dev) |
| `MAX_CONCURRENT` | Concurrent R2 download limit | `5` |
| `REFRESH_TOKEN` | Auth token for manifest refresh | (secret) |
| `MANIFEST_GITHUB_URL` | Manifest source URL | GitHub raw |

## Manifest Format

```json
{
  "version": "timestamp",
  "total_files": 1234,
  "files": {
    "Course-Name/path/to/file": "<sha256-hash>.<ext>"
  },
  "prepackages": {
    "Course-Name/First-Level-Folder": {
      "zipKey": "<hash>.zip",
      "size": 1234567
    }
  }
}
```

## R2 File Naming

Files stored as: `<sha256-hash>.<extension>`

## Important Technical Notes

1. **Path normalization**: Backslashes converted to forward slashes
2. **URL decoding**: Automatic decoding for Chinese/special characters
3. **CORS**: Fully enabled for all origins
4. **Streaming**: Single file and pre-packaged ZIPs use direct streaming
5. **Error handling**: Fault-tolerant with `allSettled` and fallbacks
6. **Worker lifecycle**: Memory cache persists for Worker lifetime
7. **Git integration**: Bound to GitHub repository, push triggers auto-deployment
8. **GitHub Actions**: Frontend push triggers manifest cache refresh via `/refresh-manifest`

## Deployment

**Automatic Deployment:**
- Worker is bound to GitHub repository
- Push to main branch triggers automatic deployment via Cloudflare

**Requirements:**
- Cloudflare account with GitHub integration
- R2 bucket named `fm-course-sharing`
- `REFRESH_TOKEN` set in Cloudflare Dashboard (secret env var)
- Same `REFRESH_TOKEN` set in frontend repo GitHub Secrets
- `WORKER_URL` set in frontend repo GitHub Secrets

**Initial Setup:**
1. Install dependencies: `npm install`
2. Login to Cloudflare: `wrangler login`
3. Configure R2 bucket and env vars in Cloudflare Dashboard
4. Deploy initially: `npm run deploy`
5. Set up GitHub Secrets in frontend repo

**Token Configuration:**
1. Generate a secure random token
2. Set in Cloudflare Dashboard → Workers & Pages → Settings → Variables:
   - `REFRESH_TOKEN`: Your secure token
3. Set in frontend repo GitHub Secrets:
   - `REFRESH_TOKEN`: Same token
   - `WORKER_URL`: Full Worker URL

## Monitoring & Troubleshooting

**View Logs:**
- Real-time: `wrangler tail`
- Last hour: `wrangler tail --format pretty --since 1h`

**Health Check Endpoints:**
- `/health` - Service status and cache info
- `/manifest-info` - Manifest version and file count

**Manual Cache Refresh:**
- Use curl with valid token to call `/refresh-manifest`

**Common Issues:**
- File not found: Check manifest.json exists in R2 and paths are correct
- Download errors: Check Worker logs and R2 bucket bindings
- CORS errors: Verify response headers are correctly set
- Performance issues: Redeploy Worker to refresh memory cache

**R2 Bucket Inspection:**
- List objects: `wrangler r2 object list fm-course-sharing --remote`
- Get manifest: `wrangler r2 object get fm-course-sharing/manifest.json --pipe --remote`

## Security Considerations

- Worker is publicly accessible by default
- Cloudflare provides basic DDoS protection
- `/refresh-manifest` is protected by bearer token
- Worker response size limit is approximately 100MB
