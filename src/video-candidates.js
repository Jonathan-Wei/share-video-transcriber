import { firstString, normalizeGenericUrl } from './utils.js';

export function collectUrlList(value, source, candidates, boost = 0, metadata = {}) {
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

export function addVideoCandidate(candidates, url, source, boost = 0, metadata = {}) {
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

export function pickBestCandidates(candidates, quality = 'best') {
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

export function isLikelyVideoUrl(url) {
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
