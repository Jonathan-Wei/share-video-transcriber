import test from 'node:test';
import assert from 'node:assert/strict';
import { addVideoCandidate, pickBestCandidates } from '../src/extractors.js';
import { collectPlatformVideoFields } from '../src/platforms/index.js';
import {
  detectPlatform,
  extractFirstUrl,
  extractItemId,
  extractShareCaption,
  parseArgs
} from '../src/utils.js';

test('extracts the first share URL and trims platform boilerplate', () => {
  const text = '看看这个视频 https://v.douyin.com/abc123/ 长按复制此条消息，打开【抖音】直接观看！';

  assert.equal(extractFirstUrl(text), 'https://v.douyin.com/abc123/');
  assert.equal(extractShareCaption(text), '看看这个视频');
});

test('detects supported share platforms and item ids', () => {
  assert.equal(detectPlatform('https://www.douyin.com/video/731234567890'), 'douyin');
  assert.equal(detectPlatform('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili');
  assert.equal(detectPlatform('https://v.kuaishou.com/short-video/3xabc'), 'kuaishou');
  assert.equal(detectPlatform('https://example.com/video/42'), 'generic');
  assert.equal(extractItemId('https://www.douyin.com/video/731234567890', 'douyin'), '731234567890');
});

test('parses CLI options without changing defaults unexpectedly', () => {
  const options = parseArgs(['--quality', 'low', '--timeout', '-1', '--json', 'https://example.com/a']);

  assert.equal(options.quality, 'low');
  assert.equal(options.timeout, 30_000);
  assert.equal(options.json, true);
  assert.equal(options.input, 'https://example.com/a');
});

test('prefers smaller transcription-friendly candidates in low quality mode', () => {
  const candidates = [];
  addVideoCandidate(candidates, 'https://cdn.example.com/video-1080p.mp4?height=1080', 'high');
  addVideoCandidate(candidates, 'https://cdn.example.com/video-360p.mp4?height=360', 'low');

  const [first] = pickBestCandidates(candidates, 'low');

  assert.match(first.url, /360p/);
});

test('dispatches platform-specific video field extraction', () => {
  const douyinCandidates = [];
  collectPlatformVideoFields(
    { video: { play_addr: { url_list: ['https://example.com/douyin.mp4'] } } },
    'fixture',
    douyinCandidates,
    { platform: 'douyin' }
  );
  assert.equal(douyinCandidates[0].url, 'https://example.com/douyin.mp4');

  const kuaishouCandidates = [];
  collectPlatformVideoFields(
    { photoId: 'other', photoUrl: 'https://example.com/kuaishou.mp4' },
    'fixture',
    kuaishouCandidates,
    { platform: 'kuaishou', itemId: 'current' }
  );
  assert.equal(kuaishouCandidates.length, 0);

  collectPlatformVideoFields(
    { photoId: 'current', photoUrl: 'https://example.com/kuaishou.mp4' },
    'fixture',
    kuaishouCandidates,
    { platform: 'kuaishou', itemId: 'current' }
  );
  assert.equal(kuaishouCandidates[0].url, 'https://example.com/kuaishou.mp4');
});
