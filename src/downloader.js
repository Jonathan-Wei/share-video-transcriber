import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  chromiumArgs,
  detectPlatform,
  extractItemId,
  resolveOutputPath,
  safeDecodeURIComponent
} from './utils.js';
import {
  addVideoCandidate,
  collectContentData,
  collectPageMetadata,
  createContentAccumulator,
  pickBestCandidates
} from './extractors.js';
import { collectPlatformEndpoints } from './platforms/index.js';
import { fetchFirstAvailableVideo, saveContentAssets } from './assets.js';

export async function downloadSharedVideo(shareUrl, options) {
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
    await collectPlatformEndpoints(
      page,
      finalUrl,
      platform,
      itemId,
      candidates,
      content,
      collectContentData
    );

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
    const video = await fetchFirstAvailableVideo(context, page, sortedCandidates, outputPath);
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
