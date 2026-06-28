#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_DIR = 'downloads';

main().catch((error) => {
  console.error(`下载失败: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.input) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const shareUrl = extractFirstUrl(options.input);
  if (!shareUrl) {
    throw new Error('没有在输入参数中找到有效的 http(s) 链接');
  }

  options.sourceText = options.input;
  const result = await downloadSharedVideo(shareUrl, options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`已保存: ${result.outputPath}`);
    console.log(`元数据: ${result.metadataPath}`);
    console.log(`视频地址: ${result.videoUrl}`);
  }
}

async function downloadSharedVideo(shareUrl, options) {
  const platform = detectPlatform(shareUrl);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: !options.headful,
    args: chromiumArgs()
  });
  const context = await browser.newContext({
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  });

  const page = await context.newPage();
  const candidates = [];
  const content = createContentAccumulator(shareUrl, platform, options.sourceText);

  page.on('response', async (response) => {
    const responseUrl = response.url();
    const contentType = response.headers()['content-type'] || '';
    const isInteresting =
      contentType.includes('application/json') ||
      /aweme|iteminfo|detail|douyin|bilibili|kuaishou|gifshow|weixin|wechat|finder|graphql|api/.test(
        responseUrl
      );

    if (!isInteresting) {
      return;
    }

    try {
      const text = await response.text();
      collectContentData(text, responseUrl, candidates, content);
    } catch {
      // Some streaming or protected responses cannot be read by Playwright.
    }
  });

  try {
    await page.goto(shareUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout
    });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(3_000);

    const finalUrl = page.url();
    const itemId = extractItemId(finalUrl, platform);
    content.itemId = itemId || '';
    candidates.length = 0;

    await collectFromPage(page, candidates, content);

    await collectPlatformEndpoints(page, finalUrl, platform, itemId, candidates, content);

    const sortedCandidates = pickBestCandidates(candidates, options.quality);
    if (sortedCandidates.length === 0) {
      throw new Error(
        '没有解析到视频地址。可以尝试加 --headful 查看是否出现验证码、登录页或风控页面'
      );
    }

    const outputPath = await resolveOutputPath(
      options,
      finalUrl,
      itemId,
      platform,
      sortedCandidates[0]?.url
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    const video = await fetchFirstAvailableVideo(
      context,
      page,
      sortedCandidates,
      outputPath
    );
    const metadata = await saveContentAssets(context, page, content, outputPath, {
      itemId,
      platform,
      finalUrl,
      videoUrl: video.url
    });

    return { outputPath, videoUrl: video.url, metadataPath: metadata.metadataPath };
  } finally {
    await browser.close();
  }
}

function chromiumArgs() {
  const args = [];
  if (/^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_NO_SANDBOX || '')) {
    args.push('--no-sandbox');
  }
  if (/^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_DISABLE_DEV_SHM || '')) {
    args.push('--disable-dev-shm-usage');
  }
  return args;
}

async function collectFromPage(page, candidates, content) {
  const data = await page.evaluate(() => {
    const scripts = Array.from(document.scripts).map((script) => ({
      id: script.id,
      text: script.textContent || ''
    }));
    const videos = Array.from(document.querySelectorAll('video')).flatMap((video) => [
      video.currentSrc,
      video.src,
      ...Array.from(video.querySelectorAll('source')).map((source) => source.src)
    ]);

    return {
      url: location.href,
      title: document.title,
      metas: Array.from(document.querySelectorAll('meta')).map((meta) => ({
        name: meta.getAttribute('name') || meta.getAttribute('property') || '',
        content: meta.getAttribute('content') || ''
      })),
      scripts,
      videos: videos.filter(Boolean)
    };
  });

  collectPageMetadata(data, content);

  for (const videoUrl of data.videos) {
    addVideoCandidate(candidates, videoUrl, 'video-tag', 30);
  }

  for (const script of data.scripts) {
    if (!script.text) {
      continue;
    }

    const text =
      script.id === 'RENDER_DATA' ? safeDecodeURIComponent(script.text) : script.text;

    collectContentData(text, `script:${script.id || 'inline'}`, candidates, content);
  }
}

async function collectPlatformEndpoints(page, finalUrl, platform, itemId, candidates, content) {
  if (platform === 'douyin' && itemId) {
    await collectDouyinDetailEndpoint(page, itemId, candidates, content);
  } else if (platform === 'bilibili') {
    await collectBilibiliEndpoints(page, finalUrl, itemId, candidates, content);
  }
}

async function collectDouyinDetailEndpoint(page, awemeId, candidates, content) {
  const detail = await page.evaluate(async (id) => {
    const endpoint = new URL('/aweme/v1/web/aweme/detail/', location.origin);
    endpoint.searchParams.set('aweme_id', id);
    endpoint.searchParams.set('aid', '6383');
    endpoint.searchParams.set('device_platform', 'webapp');

    const response = await fetch(endpoint.toString(), {
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*'
      }
    });

    if (!response.ok) {
      throw new Error(`detail endpoint returned ${response.status}`);
    }

    return response.text();
  }, awemeId).catch(() => null);

  if (detail) {
    collectContentData(detail, 'detail-endpoint', candidates, content);
  }
}

async function collectBilibiliEndpoints(page, finalUrl, itemId, candidates, content) {
  const details = await page.evaluate(async ({ url, id }) => {
    const results = [];
    const pageUrl = new URL(url);
    const bvid = id || pageUrl.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)?.[1] || '';

    if (bvid) {
      const view = new URL('/x/web-interface/view', 'https://api.bilibili.com');
      view.searchParams.set('bvid', bvid);
      const viewResponse = await fetch(view.toString(), { credentials: 'include' });
      if (viewResponse.ok) {
        const text = await viewResponse.text();
        results.push({ source: 'bilibili-view-api', text });

        try {
          const json = JSON.parse(text);
          const cid = json.data?.cid;
          if (cid) {
            const play = new URL('/x/player/wbi/playurl', 'https://api.bilibili.com');
            play.searchParams.set('bvid', bvid);
            play.searchParams.set('cid', String(cid));
            play.searchParams.set('qn', '80');
            play.searchParams.set('fnval', '16');
            play.searchParams.set('fourk', '1');
            const playResponse = await fetch(play.toString(), { credentials: 'include' });
            if (playResponse.ok) {
              results.push({
                source: 'bilibili-playurl-api',
                text: await playResponse.text()
              });
            }
          }
        } catch {
          // Page scripts may still contain playable URLs.
        }
      }
    }

    return results;
  }, { url: finalUrl, id: itemId }).catch(() => []);

  for (const detail of details) {
    collectContentData(detail.text, detail.source, candidates, content);
  }
}

async function fetchVideo(context, page, videoUrl, outputPath) {
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

async function fetchFirstAvailableVideo(context, page, candidates, outputPath) {
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

async function saveContentAssets(context, page, content, videoPath, extra) {
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

function renderProgress(downloaded, total) {
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

function clearProgressLine() {
  process.stderr.write('\r\x1b[K');
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

function onceFinished(stream) {
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
}

function guessExtension(url, fallback) {
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

function createContentAccumulator(shareUrl, platform, sourceText = '') {
  return {
    shareUrl,
    sourceText,
    shareCaption: extractShareCaption(sourceText),
    platform,
    title: '',
    desc: '',
    author: '',
    authorId: '',
    musicTitle: '',
    coverUrls: [],
    subtitleCandidates: [],
    itemId: '',
    hashtags: []
  };
}

function collectContentData(rawText, source, candidates, content) {
  if (!rawText) {
    return;
  }

  let parsedStructuredData = false;
  const json = parseLooseJson(rawText);
  if (json) {
    collectFromJsonValue(json, source, candidates, content);
    parsedStructuredData = true;
  }

  for (const assignedJson of extractAssignedJsonValues(rawText)) {
    collectFromJsonValue(assignedJson, source, candidates, content);
    parsedStructuredData = true;
  }

  if (!parsedStructuredData) {
    for (const url of extractVideoUrls(rawText)) {
      addVideoCandidate(candidates, url, source);
    }
  }
}

function collectFromJsonValue(value, source, candidates, content) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFromJsonValue(item, source, candidates, content);
    }
    return;
  }

  collectKnownVideoFields(value, source, candidates, content);
  collectKnownMetadataFields(value, source, content);

  for (const child of Object.values(value)) {
    collectFromJsonValue(child, source, candidates, content);
  }
}

function collectPageMetadata(data, content) {
  setFirstText(content, 'title', cleanTitle(data.title));

  for (const meta of data.metas) {
    const key = meta.name.toLowerCase();
    const value = meta.content;

    if (['og:title', 'twitter:title'].includes(key)) {
      setFirstText(content, 'title', cleanTitle(value));
    } else if (['description', 'og:description', 'twitter:description'].includes(key)) {
      setFirstText(content, 'desc', value);
    } else if (['og:image', 'twitter:image'].includes(key)) {
      addUniqueUrl(content.coverUrls, value);
    }
  }
}

function collectKnownMetadataFields(value, source, content) {
  setFirstText(content, 'desc', value.desc);
  setFirstText(content, 'desc', value.description);
  setFirstText(content, 'desc', value.caption);
  setFirstText(content, 'desc', value.content);
  setFirstText(content, 'desc', value.objectDesc);
  setFirstText(content, 'desc', value.videoData?.desc);
  setFirstText(content, 'desc', value.item?.desc);
  setFirstText(content, 'desc', value.photo?.caption);
  setFirstText(content, 'title', value.item_title);
  setFirstText(content, 'title', value.title);
  setFirstText(content, 'title', value.videoData?.title);
  setFirstText(content, 'title', value.item?.title);
  setFirstText(content, 'title', value.photo?.caption);
  setFirstText(content, 'title', value.share_info?.share_title);
  setFirstText(content, 'author', value.author?.nickname);
  setFirstText(content, 'author', value.owner?.name);
  setFirstText(content, 'author', value.user?.name || value.user?.user_name);
  setFirstText(content, 'author', value.photo?.userName);
  setFirstText(content, 'author', value.nickname);
  setFirstText(content, 'authorId', value.author?.unique_id || value.author?.short_id);
  setFirstText(content, 'authorId', value.owner?.mid ? String(value.owner.mid) : '');
  setFirstText(content, 'authorId', value.user?.id || value.user?.eid);
  setFirstText(content, 'authorId', value.photo?.userId);
  setFirstText(content, 'musicTitle', value.music?.title);

  for (const tag of value.text_extra || value.cha_list || []) {
    const name = tag.hashtag_name || tag.cha_name || tag.word;
    if (name && !content.hashtags.includes(name)) {
      content.hashtags.push(name);
    }
  }

  collectImageUrls(value.video?.cover, content.coverUrls);
  collectImageUrls(value.video?.origin_cover, content.coverUrls);
  collectImageUrls(value.video?.dynamic_cover, content.coverUrls);
  collectImageUrls(value.cover, content.coverUrls);
  collectImageUrls(value.pic, content.coverUrls);
  collectImageUrls(value.image, content.coverUrls);
  collectImageUrls(value.poster, content.coverUrls);
  collectImageUrls(value.coverUrl, content.coverUrls);
  collectImageUrls(value.coverUrls, content.coverUrls);
  collectImageUrls(value.photo?.coverUrls, content.coverUrls);
  collectImageUrls(value.photo?.webpCoverUrls, content.coverUrls);
  collectImageUrls(value.videoData?.pic, content.coverUrls);
  collectImageUrls(value.item?.pic, content.coverUrls);
  collectImageUrls(value.share_info?.share_image_url, content.coverUrls);
  collectSubtitleCandidates(value.video?.cla_info?.caption_infos, source, content);
  collectSubtitleCandidates(value.video?.subtitle_infos, source, content);
  collectSubtitleCandidates(value.videoData?.subtitle, source, content);
  collectSubtitleCandidates(value.subtitle?.subtitles, source, content);
  collectSubtitleCandidates(value.subtitle_infos, source, content);
  collectSubtitleCandidates(value.caption_infos, source, content);
}

function collectImageUrls(value, target) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    addUniqueUrl(target, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageUrls(item, target);
    }
    return;
  }

  if (typeof value === 'object') {
    collectImageUrls(value.url_list, target);
    collectImageUrls(value.urlList, target);
    collectImageUrls(value.uri, target);
  }
}

function collectSubtitleCandidates(value, source, content) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSubtitleCandidates(item, source, content);
    }
    return;
  }

  if (typeof value === 'string') {
    if (isLikelySubtitleUrl(value)) {
      addSubtitleCandidate(content, { url: value, source });
    }
    return;
  }

  if (typeof value === 'object') {
    const url = firstString(
      value.subtitle_url,
      value.caption_url,
      value.webvtt_url,
      value.srt_url,
      value.ass_url,
      value.url,
      value.main_url,
      value.url_list?.[0],
      value.urlList?.[0]
    );
    const format = firstString(value.format, value.caption_format, value.mime_type, value.type);

    if (url) {
      addSubtitleCandidate(content, {
        url,
        source,
        language: firstString(value.language, value.lang, value.language_code),
        format
      });
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object' && isSubtitleContainer(child)) {
        collectSubtitleCandidates(child, source, content);
      }
    }
  }
}

function addSubtitleCandidate(content, candidate) {
  const url = normalizeGenericUrl(candidate.url);
  if (
    !url ||
    !isLikelySubtitleUrl(url, candidate) ||
    content.subtitleCandidates.some((item) => item.url === url)
  ) {
    return;
  }

  content.subtitleCandidates.push({ ...candidate, url });
}

function isSubtitleContainer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).some((key) =>
    /subtitle|caption|webvtt|srt|ass|字幕|cla_info|caption_info/i.test(key)
  );
}

function isLikelySubtitleUrl(url, candidate = {}) {
  const normalizedUrl = normalizeGenericUrl(url);
  const format = firstString(candidate.format).toLowerCase();

  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return false;
  }

  if (/\.(vtt|srt|ass|ssa|ttml|dfxp)(\?|$)/i.test(normalizedUrl)) {
    return true;
  }

  if (/subtitle|caption|webvtt|subtitles|captions|cla/i.test(normalizedUrl)) {
    return !/\.(mp4|m4s|flv|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i.test(normalizedUrl);
  }

  return /vtt|srt|ass|ssa|ttml|caption|subtitle/.test(format);
}

function collectKnownVideoFields(value, source, candidates, content) {
  if (content.platform === 'kuaishou') {
    collectKuaishouVideoFields(value, source, candidates, content);
    return;
  }

  const video = value.video || value.aweme_detail?.video;

  if (video && typeof video === 'object') {
    const fields = [
      { value: video.play_addr_h264, boost: 90 },
      { value: video.play_addr, boost: 85 },
      { value: video.play_addr_265, boost: 80 },
      { value: video.bit_rate, boost: 65 },
      { value: video.download_addr, boost: -50 }
    ];

    for (const field of fields) {
      collectUrlList(field.value, source, candidates, field.boost);
    }
  }

  collectUrlList(value.play_addr, source, candidates, 70);
  collectUrlList(value.playAddr, source, candidates, 70);
  collectUrlList(value.src, source, candidates, 20);
  collectUrlList(value.url, source, candidates, 10);
  collectUrlList(value.baseUrl, source, candidates, 55);
  collectUrlList(value.base_url, source, candidates, 55);
  collectUrlList(value.backupUrl, source, candidates, 45);
  collectUrlList(value.backup_url, source, candidates, 45);
  collectUrlList(value.durl, source, candidates, 90);
  collectUrlList(value.dash?.video, source, candidates, 55);
  collectUrlList(value.data?.durl, source, candidates, 90);
  collectUrlList(value.data?.dash?.video, source, candidates, 55);
  collectUrlList(value.videoData?.pages, source, candidates, 5);
  collectUrlList(value.photo?.mainMvUrls, source, candidates, 80);
  collectUrlList(value.photo?.photoUrl, source, candidates, 75);
  collectUrlList(value.photo?.manifest?.adaptationSet, source, candidates, 70);
  collectUrlList(value.mediaUrl, source, candidates, 75);
  collectUrlList(value.media_url, source, candidates, 75);
  collectUrlList(value.videoUrl, source, candidates, 75);
  collectUrlList(value.video_url, source, candidates, 75);
  collectUrlList(value.fullUrl, source, candidates, 75);
  collectUrlList(value.full_url, source, candidates, 75);
  collectUrlList(value.fileUrl, source, candidates, 75);
  collectUrlList(value.file_url, source, candidates, 75);
  collectUrlList(value.urlInfo, source, candidates, 65);
}

function collectKuaishouVideoFields(value, source, candidates, content) {
  const photo = value.photo && typeof value.photo === 'object' ? value.photo : value;
  const photoId = firstString(
    photo.photoId,
    photo.id,
    photo.photo_id,
    value.photoId,
    value.photo_id
  );

  if (content.itemId && photoId && photoId !== content.itemId) {
    return;
  }

  const hasKuaishouVideoShape =
    photo.mainMvUrls ||
    photo.photoUrl ||
    photo.manifest?.adaptationSet ||
    photo.videoUrl ||
    photo.video_url ||
    photo.ext_params?.atlas?.cdn;

  if (!hasKuaishouVideoShape) {
    return;
  }

  const boost = photoId === content.itemId ? 140 : 40;
  collectUrlList(photo.mainMvUrls, source, candidates, boost);
  collectUrlList(photo.photoUrl, source, candidates, boost);
  collectUrlList(photo.manifest?.adaptationSet, source, candidates, boost);
  collectUrlList(photo.videoUrl, source, candidates, boost);
  collectUrlList(photo.video_url, source, candidates, boost);
  collectUrlList(photo.ext_params?.atlas?.cdn, source, candidates, boost);
}

function collectUrlList(value, source, candidates, boost = 0, metadata = {}) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    addVideoCandidate(candidates, value, source, boost, metadata);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlList(item, source, candidates, boost, metadata);
    }
    return;
  }

  if (typeof value === 'object') {
    const nestedMetadata = mergeVideoMetadata(metadata, value);
    collectUrlList(value.url_list, source, candidates, boost, nestedMetadata);
    collectUrlList(value.urlList, source, candidates, boost, nestedMetadata);
    collectUrlList(value.uri, source, candidates, boost, nestedMetadata);
    collectUrlList(value.main_url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.cdn, source, candidates, boost, nestedMetadata);
    collectUrlList(value.baseUrl, source, candidates, boost, nestedMetadata);
    collectUrlList(value.base_url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.backupUrl, source, candidates, boost, nestedMetadata);
    collectUrlList(value.backup_url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.representation, source, candidates, boost, nestedMetadata);
    collectUrlList(value.mediaUrl, source, candidates, boost, nestedMetadata);
    collectUrlList(value.media_url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.videoUrl, source, candidates, boost, nestedMetadata);
    collectUrlList(value.video_url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.fullUrl, source, candidates, boost, nestedMetadata);
    collectUrlList(value.full_url, source, candidates, boost, nestedMetadata);
    collectUrlList(value.fileUrl, source, candidates, boost, nestedMetadata);
    collectUrlList(value.file_url, source, candidates, boost, nestedMetadata);
  }
}

function addVideoCandidate(candidates, url, source, boost = 0, metadata = {}) {
  const normalizedUrl = normalizeVideoUrl(url);
  if (!isLikelyVideoUrl(normalizedUrl)) {
    return;
  }

  const quality = analyzeVideoQuality(normalizedUrl, metadata);
  candidates.push({
    url: normalizedUrl,
    source,
    score: scoreVideoUrl(normalizedUrl) + boost,
    quality
  });

  const noWatermarkUrl = toNoWatermarkUrl(normalizedUrl);
  if (noWatermarkUrl !== normalizedUrl && isLikelyVideoUrl(noWatermarkUrl)) {
    candidates.push({
      url: noWatermarkUrl,
      source: `${source}:no-watermark-rewrite`,
      score: scoreVideoUrl(noWatermarkUrl) + boost + 45,
      quality: analyzeVideoQuality(noWatermarkUrl, metadata)
    });
  }
}

function pickBestCandidates(candidates, quality = 'best') {
  const unique = new Map();

  for (const candidate of candidates) {
    if (!candidate.url || !isLikelyVideoUrl(candidate.url)) {
      continue;
    }

    const score = Math.max(candidate.score ?? 0, scoreVideoUrl(candidate.url));
    const existing = unique.get(candidate.url);
    if (!existing || score > existing.score) {
      unique.set(candidate.url, { ...candidate, score });
    }
  }

  const values = Array.from(unique.values());
  if (quality === 'low') {
    return values.sort(compareLowQualityCandidates);
  }

  return values.sort((a, b) => b.score - a.score);
}

function compareLowQualityCandidates(a, b) {
  const suitabilityDiff = transcriptionSuitabilityScore(b) - transcriptionSuitabilityScore(a);
  if (suitabilityDiff !== 0) return suitabilityDiff;

  const qualityDiff = lowQualityScore(a) - lowQualityScore(b);
  if (qualityDiff !== 0) return qualityDiff;

  return b.score - a.score;
}

function transcriptionSuitabilityScore(candidate) {
  let score = 0;
  const url = candidate.url || '';

  if (/\.mp4(\?|$)|\.flv(\?|$)|play_addr|playaddr|play\//i.test(url)) score += 30;
  if (/\.m4s(\?|$)|dash|mime_type=video_dash/i.test(url)) score -= 40;
  if (/audio|voice|mime_type=audio/i.test(url)) score += 20;

  return score;
}

function lowQualityScore(candidate) {
  const quality = candidate.quality || {};
  let score = 0;

  if (quality.height) score += quality.height;
  if (quality.width) score += quality.width / 4;
  if (quality.bitrate) score += quality.bitrate / 1000;
  if (quality.size) score += quality.size / 1024 / 1024;
  if (!quality.height && !quality.width && !quality.bitrate && !quality.size) {
    score += 720;
  }

  return score;
}

function mergeVideoMetadata(base, value) {
  return {
    ...base,
    width: firstNumber(base.width, value.width, value.w),
    height: firstNumber(base.height, value.height, value.h),
    bitrate: firstNumber(
      base.bitrate,
      value.bit_rate,
      value.bitrate,
      value.bitRate,
      value.bandwidth,
      value.video_bitrate
    ),
    size: firstNumber(base.size, value.size, value.file_size, value.fileSize, value.data_size),
    quality: firstString(base.quality, value.quality, value.qualityType, value.definition, value.format)
  };
}

function analyzeVideoQuality(url, metadata = {}) {
  const quality = {
    width: firstNumber(metadata.width, numberFromUrl(url, /(?:width|w)=([0-9]+)/i)),
    height: firstNumber(
      metadata.height,
      numberFromUrl(url, /(?:height|h)=([0-9]+)/i),
      numberFromUrl(url, /(?:ratio|quality|definition)=([0-9]{3,4})p?/i),
      numberFromUrl(url, /([0-9]{3,4})p/i)
    ),
    bitrate: firstNumber(
      metadata.bitrate,
      numberFromUrl(url, /(?:bitrate|br|bandwidth)=([0-9]+)/i)
    ),
    size: firstNumber(metadata.size, numberFromUrl(url, /(?:size|filesize|file_size)=([0-9]+)/i)),
    label: firstString(metadata.quality)
  };

  if (!quality.height && /(?:low|ld|360|480|540)/i.test(quality.label)) {
    quality.height = numberFromUrl(quality.label, /([0-9]{3,4})/) || 480;
  }

  return quality;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

function numberFromUrl(value, pattern) {
  const match = String(value || '').match(pattern);
  return match ? Number(match[1]) : 0;
}

function scoreVideoUrl(url) {
  let score = 10;

  if (/\.mp4(\?|$)/i.test(url)) score += 40;
  if (/\.m4s(\?|$)/i.test(url)) score += 10;
  if (/\.flv(\?|$)/i.test(url)) score += 20;
  if (/play_addr|video_id|mime_type=video_mp4/i.test(url)) score += 35;
  if (/play\/|playaddr|play_addr_h264/i.test(url)) score += 35;
  if (/bilibili|bilivideo|akamaized|ksy|kuaishou|gifshow|weixin|wechat|finder/i.test(url)) {
    score += 10;
  }
  if (/watermark|playwm|download_addr|wm=1/i.test(url)) score -= 90;
  if (/douyin|amemv|ixigua|byte/i.test(url)) score += 10;
  if (/https:\/\//i.test(url)) score += 5;

  return score;
}

function parseLooseJson(text) {
  const trimmed = text.trim();

  for (const candidate of [
    trimmed,
    safeDecodeURIComponent(trimmed),
    trimmed.replace(/&quot;/g, '"').replace(/\\u002F/g, '/')
  ]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

function extractAssignedJsonValues(text) {
  const values = [];
  const markers = [
    '__INITIAL_STATE__',
    '__playinfo__',
    '__NEXT_DATA__',
    'window.__APOLLO_STATE__',
    'window.__NUXT__',
    'window.__data__',
    'window.__INITIAL_DATA__'
  ];

  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index === -1) {
      continue;
    }

    const start = text.indexOf('{', index);
    if (start === -1) {
      continue;
    }

    const jsonText = readBalancedJson(text, start);
    if (!jsonText) {
      continue;
    }

    const parsed = parseLooseJson(jsonText);
    if (parsed) {
      values.push(parsed);
    }
  }

  return values;
}

function readBalancedJson(text, start) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return '';
}

function extractVideoUrls(text) {
  const urls = new Set();
  const decoded = safeDecodeURIComponent(text)
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  const pattern = /https?:\/\/[^"'\\\s<>]+/gi;
  for (const match of decoded.matchAll(pattern)) {
    const url = cleanUrl(match[0]);
    if (isLikelyVideoUrl(url)) {
      urls.add(url);
    }
  }

  return Array.from(urls);
}

function isLikelyVideoUrl(url) {
  return (
    /^https?:\/\//i.test(url) &&
    (/\.mp4(\?|$)/i.test(url) ||
      /\.m4s(\?|$)/i.test(url) ||
      /\.flv(\?|$)/i.test(url) ||
      /play_addr|playwm|video_id|mime_type=video_mp4|aweme|bilivideo|kuaishou|gifshow|finder|media/i.test(
        url
      ))
  );
}

function normalizeVideoUrl(url) {
  return normalizeGenericUrl(url);
}

function toNoWatermarkUrl(url) {
  let rewritten = url
    .replace(/playwm(?=[/?&]|$)/gi, 'play')
    .replace(/watermark=1/gi, 'watermark=0')
    .replace(/wm=1/gi, 'wm=0');

  try {
    const parsedUrl = new URL(rewritten);
    for (const key of ['watermark', 'wm']) {
      if (parsedUrl.searchParams.get(key) === '1') {
        parsedUrl.searchParams.set(key, '0');
      }
    }
    rewritten = parsedUrl.toString();
  } catch {
    // Keep the string-level rewrite when the URL parser cannot handle it.
  }

  return rewritten;
}

function cleanUrl(url) {
  return url.replace(/[),.;\]}]+$/g, '').replace(/&amp;/g, '&');
}

function normalizeGenericUrl(url) {
  if (!url || typeof url !== 'string') {
    return '';
  }

  const normalized = cleanUrl(
    safeDecodeURIComponent(url).replace(/\\u002F/g, '/').replace(/\\\//g, '/')
  );

  return normalized.startsWith('//') ? `https:${normalized}` : normalized;
}

function addUniqueUrl(target, url) {
  const normalizedUrl = normalizeGenericUrl(url);
  if (/^https?:\/\//i.test(normalizedUrl) && !target.includes(normalizedUrl)) {
    target.push(normalizedUrl);
  }
}

function setFirstText(target, key, value) {
  const text = firstString(value).trim();
  if (text && (!target[key] || isGenericText(target[key]))) {
    target[key] = text;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return '';
}

function cleanTitle(value) {
  return firstString(value)
    .replace(/\s*-\s*抖音\s*$/i, '')
    .replace(/\s*，?抖音记录美好生活\s*$/i, '')
    .trim();
}

function titleFromDesc(desc) {
  return firstString(desc).split(/\r?\n/)[0].slice(0, 80);
}

function resolveTitle(content) {
  if (
    content.platform === 'kuaishou' &&
    content.shareCaption &&
    (!content.title || content.title.length < 10 || isGenericText(content.title))
  ) {
    return titleFromDesc(content.shareCaption);
  }

  return content.title || titleFromDesc(content.desc) || titleFromDesc(content.shareCaption);
}

function isGenericText(value) {
  return /^(抖音|douyin|抖音短视频|更多精彩视频等你来看)$/i.test(firstString(value).trim());
}

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? cleanUrl(match[0]) : null;
}

function extractShareCaption(text) {
  const withoutUrl = firstString(text)
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/长按复制此条消息，打开【[^】]+】直接观看！?/g, '')
    .replace(/复制打开[^，。]*[，。]?/g, '')
    .trim();

  return withoutUrl.replace(/\s+/g, ' ').trim();
}

function detectPlatform(url) {
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

function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function extractItemId(url, platform) {
  const platformPatterns = {
    douyin: [/\/video\/(\d+)/, /modal_id=(\d+)/, /aweme_id=(\d+)/, /note\/(\d+)/],
    bilibili: [/\/video\/(BV[a-zA-Z0-9]+)/, /\/video\/av(\d+)/i, /bvid=(BV[a-zA-Z0-9]+)/],
    kuaishou: [/photoId=([a-zA-Z0-9_-]+)/, /short-video\/([a-zA-Z0-9_-]+)/, /\/fw\/photo\/([a-zA-Z0-9_-]+)/],
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

async function resolveOutputPath(options, finalUrl, itemId, platform, videoUrl = '') {
  if (options.output) {
    return path.resolve(options.output);
  }

  const id = itemId || extractItemId(finalUrl, platform) || String(Date.now());
  return path.resolve(
    options.dir || DEFAULT_DIR,
    `${platform}-${sanitizeFilename(id)}${guessExtension(videoUrl, '.mp4')}`
  );
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseArgs(args) {
  const options = {
    dir: DEFAULT_DIR,
    timeout: DEFAULT_TIMEOUT,
    headful: false,
    json: false,
    quality: 'best',
    output: null,
    input: null
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
      printHelp();
      process.exit(0);
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

function printHelp() {
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
