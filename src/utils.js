import path from 'node:path';
import process from 'node:process';

export const DEFAULT_TIMEOUT = 30_000;
export const DEFAULT_DIR = 'downloads';

export function chromiumArgs() {
  const args = [];
  if (/^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_NO_SANDBOX || '')) {
    args.push('--no-sandbox');
  }
  if (/^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_DISABLE_DEV_SHM || '')) {
    args.push('--disable-dev-shm-usage');
  }
  return args;
}

export function renderProgress(downloaded, total) {
  if (!total) {
    process.stderr.write(`\r下载中: ${formatBytes(downloaded)}`);
    return;
  }

  const percent = Math.min(downloaded / total, 1);
  const barWidth = 24;
  const filled = Math.round(percent * barWidth);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`;
  const label = `${(percent * 100).toFixed(1).padStart(5)}%`;

  process.stderr.write(
    `\r下载中: [${bar}] ${label} ${formatBytes(downloaded)} / ${formatBytes(total)}`
  );
}

export function clearProgressLine() {
  process.stderr.write('\r\x1b[K');
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

export function onceFinished(stream) {
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
}

export function guessExtension(url, fallback) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(
      /\.(mp4|m4s|flv|jpg|jpeg|png|webp|gif|vtt|srt|json|ass|ssa|txt)$/
    );
    if (match) {
      return `.${match[1]}`;
    }
  } catch {
    // Use fallback below.
  }

  return fallback;
}

export function cleanUrl(url) {
  return url.replace(/[),.;\]}]+$/g, '').replace(/&amp;/g, '&');
}

export function normalizeGenericUrl(url) {
  if (!url || typeof url !== 'string') {
    return '';
  }

  const normalized = cleanUrl(
    safeDecodeURIComponent(url).replace(/\\u002F/g, '/').replace(/\\\//g, '/')
  );

  return normalized.startsWith('//') ? `https:${normalized}` : normalized;
}

export function addUniqueUrl(target, url) {
  const normalizedUrl = normalizeGenericUrl(url);
  if (/^https?:\/\//i.test(normalizedUrl) && !target.includes(normalizedUrl)) {
    target.push(normalizedUrl);
  }
}

export function setFirstText(target, key, value) {
  const text = firstString(value).trim();
  if (text && (!target[key] || isGenericText(target[key]))) {
    target[key] = text;
  }
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return '';
}

export function cleanTitle(value) {
  return firstString(value)
    .replace(/\s*-\s*抖音\s*$/i, '')
    .replace(/\s*，?抖音记录美好生活\s*$/i, '')
    .trim();
}

export function titleFromDesc(desc) {
  return firstString(desc).split(/\r?\n/)[0].slice(0, 80);
}

export function resolveTitle(content) {
  if (
    content.platform === 'kuaishou' &&
    content.shareCaption &&
    (!content.title || content.title.length < 10 || isGenericText(content.title))
  ) {
    return titleFromDesc(content.shareCaption);
  }

  return content.title || titleFromDesc(content.desc) || titleFromDesc(content.shareCaption);
}

export function isGenericText(value) {
  return /^(抖音|douyin|抖音短视频|更多精彩视频等你来看)$/i.test(firstString(value).trim());
}

export function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? cleanUrl(match[0]) : null;
}

export function extractShareCaption(text) {
  const withoutUrl = firstString(text)
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/长按复制此条消息，打开【[^】]+】直接观看！?/g, '')
    .replace(/复制打开[^，。]*[，。]?/g, '')
    .trim();

  return withoutUrl.replace(/\s+/g, ' ').trim();
}

export function detectPlatform(url) {
  const hostname = safeHostname(url);

  if (/douyin\.com|iesdouyin\.com|amemv\.com/.test(hostname)) {
    return 'douyin';
  }

  if (/bilibili\.com|b23\.tv/.test(hostname)) {
    return 'bilibili';
  }

  if (/kuaishou\.com|gifshow\.com|chenzhongtech\.com|k\.uaishou\.com/.test(hostname)) {
    return 'kuaishou';
  }

  if (/weixin\.qq\.com|weishi\.qq\.com|channels\.weixin\.qq\.com/.test(hostname)) {
    return 'wechat_channels';
  }

  return 'generic';
}

export function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function extractItemId(url, platform) {
  const platformPatterns = {
    douyin: [/\/video\/(\d+)/, /modal_id=(\d+)/, /aweme_id=(\d+)/, /note\/(\d+)/],
    bilibili: [/\/video\/(BV[a-zA-Z0-9]+)/, /\/video\/av(\d+)/i, /bvid=(BV[a-zA-Z0-9]+)/],
    kuaishou: [
      /photoId=([a-zA-Z0-9_-]+)/,
      /short-video\/([a-zA-Z0-9_-]+)/,
      /\/fw\/photo\/([a-zA-Z0-9_-]+)/
    ],
    wechat_channels: [/exportkey=([^&]+)/, /feedid=([^&]+)/, /objectid=([^&]+)/]
  };
  const patterns = platformPatterns[platform] || [
    /\/video\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return sanitizeFilename(safeDecodeURIComponent(match[1]));
    }
  }

  return null;
}

export async function resolveOutputPath(options, finalUrl, itemId, platform, videoUrl = '') {
  if (options.output) {
    return path.resolve(options.output);
  }

  const id = itemId || extractItemId(finalUrl, platform) || String(Date.now());
  return path.resolve(
    options.dir || DEFAULT_DIR,
    `${platform}-${sanitizeFilename(id)}${guessExtension(videoUrl, '.mp4')}`
  );
}

export function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseArgs(args) {
  const options = {
    dir: DEFAULT_DIR,
    timeout: DEFAULT_TIMEOUT,
    headful: false,
    json: false,
    quality: 'best',
    output: null,
    input: null,
    help: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (arg === '--dir' || arg === '-d') {
      options.dir = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number(args[++i]);
    } else if (arg === '--headful') {
      options.headful = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--quality') {
      const value = String(args[++i] || '').toLowerCase();
      options.quality = value === 'low' ? 'low' : 'best';
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!options.input) {
      options.input = arg;
    } else {
      options.input += ` ${arg}`;
    }
  }

  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    options.timeout = DEFAULT_TIMEOUT;
  }

  return options;
}

export function printHelp() {
  console.log(`用法:
  npm run download -- "<分享链接或分享文案>"

支持:
  抖音、Bilibili、快手、视频号

参数:
  -o, --output <file>   指定输出文件
  -d, --dir <dir>       指定保存目录，默认 downloads
  --headful             显示浏览器窗口
  --json                以 JSON 输出最终结果
  --quality <best|low>  下载候选偏好，默认 best；转写场景可用 low
  --timeout <ms>        页面等待超时时间，默认 30000
`);
}
