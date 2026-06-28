import {
  addUniqueUrl,
  cleanTitle,
  cleanUrl,
  firstString,
  normalizeGenericUrl,
  safeDecodeURIComponent,
  setFirstText
} from './utils.js';
import { collectPlatformVideoFields } from './platforms/index.js';
import { addVideoCandidate, isLikelyVideoUrl } from './video-candidates.js';

export { addVideoCandidate, pickBestCandidates } from './video-candidates.js';

export function createContentAccumulator(shareUrl, platform, sourceText = '') {
  return {
    shareUrl,
    sourceText,
    shareCaption: extractShareCaptionLocal(sourceText),
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

export function collectContentData(rawText, source, candidates, content) {
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

  collectPlatformVideoFields(value, source, candidates, content);
  collectKnownMetadataFields(value, source, content);

  for (const child of Object.values(value)) {
    collectFromJsonValue(child, source, candidates, content);
  }
}

export function collectPageMetadata(data, content) {
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

function extractShareCaptionLocal(text) {
  const withoutUrl = firstString(text)
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/长按复制此条消息，打开【[^】]+】直接观看！?/g, '')
    .replace(/复制打开[^，。]*[，。]?/g, '')
    .trim();

  return withoutUrl.replace(/\s+/g, ' ').trim();
}
