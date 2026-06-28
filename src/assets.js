import { createWriteStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import {
  DEFAULT_TIMEOUT,
  clearProgressLine,
  guessExtension,
  normalizeGenericUrl,
  onceDrain,
  onceFinished,
  renderProgress,
  resolveTitle
} from './utils.js';

export async function fetchVideo(context, page, videoUrl, outputPath) {
  const cookies = await context.cookies(videoUrl);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const partPath = `${outputPath}.part`;

  const response = await fetch(videoUrl, {
    headers: {
      cookie: cookieHeader,
      referer: page.url(),
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`视频下载请求失败: HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('视频响应没有可读取的内容');
  }

  await rm(partPath, { force: true });
  await writeResponseBodyWithProgress(response, partPath);
  await rename(partPath, outputPath);
}

export async function fetchFirstAvailableVideo(context, page, candidates, outputPath) {
  const failures = [];

  for (const [index, video] of candidates.entries()) {
    try {
      console.error(`尝试下载候选 ${index + 1}/${candidates.length}: ${video.source}`);
      await fetchVideo(context, page, video.url, outputPath);
      return video;
    } catch (error) {
      clearProgressLine();
      failures.push(`${video.source}: ${error.message}`);
      await rm(`${outputPath}.part`, { force: true }).catch(() => {});
    }
  }

  throw new Error(`候选视频地址都下载失败: ${failures.slice(0, 3).join(' | ')}`);
}

export async function saveContentAssets(context, page, content, videoPath, extra) {
  const basePath = videoPath.replace(/\.[^.]+$/, '');
  const metadataPath = `${basePath}.json`;
  const coverUrl = content.coverUrls[0] || '';
  const coverPath = coverUrl ? `${basePath}.cover${guessExtension(coverUrl, '.jpg')}` : '';
  const subtitles = [];

  if (coverUrl) {
    await fetchAsset(context, page, coverUrl, coverPath).catch((error) => {
      console.error(`封面下载失败: ${error.message}`);
    });
  }

  for (const [index, subtitle] of content.subtitleCandidates.slice(0, 5).entries()) {
    const subtitlePath = `${basePath}.subtitle-${index + 1}${guessExtension(
      subtitle.url,
      '.vtt'
    )}`;

    try {
      await fetchAsset(context, page, subtitle.url, subtitlePath);
      subtitles.push({ ...subtitle, path: subtitlePath });
    } catch (error) {
      console.error(`字幕下载失败: ${error.message}`);
    }
  }

  const metadata = {
    platform: extra.platform,
    itemId: extra.itemId || '',
    shareUrl: content.shareUrl,
    sourceText: content.sourceText,
    finalUrl: extra.finalUrl,
    title: resolveTitle(content),
    desc: content.desc || content.shareCaption,
    shareCaption: content.shareCaption,
    author: content.author,
    authorId: content.authorId,
    musicTitle: content.musicTitle,
    hashtags: content.hashtags,
    video: {
      url: extra.videoUrl,
      path: videoPath
    },
    cover: {
      url: coverUrl,
      path: coverPath
    },
    subtitles,
    rawSubtitleCandidates: content.subtitleCandidates
  };

  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { metadataPath, metadata };
}

async function fetchAsset(context, page, url, outputPath) {
  const normalizedUrl = normalizeGenericUrl(url);
  const cookies = await context.cookies(normalizedUrl);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const response = await fetch(normalizedUrl, {
    headers: {
      cookie: cookieHeader,
      referer: page.url(),
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(outputPath, Buffer.from(arrayBuffer));
}

async function writeResponseBodyWithProgress(response, outputPath) {
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const output = createWriteStream(outputPath);
  let downloaded = 0;
  let lastRenderedAt = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      downloaded += value.byteLength;
      if (!output.write(Buffer.from(value))) {
        await onceDrain(output);
      }

      const now = Date.now();
      if (now - lastRenderedAt > 100 || downloaded === total) {
        renderProgress(downloaded, total);
        lastRenderedAt = now;
      }
    }
  } finally {
    output.end();
  }

  await onceFinished(output);
  renderProgress(downloaded, total);
  process.stderr.write('\n');
}
