import { collectBilibiliEndpoints, collectBilibiliVideoFields } from './bilibili.js';
import { collectDouyinDetailEndpoint, collectDouyinVideoFields } from './douyin.js';
import { collectGenericVideoFields } from './generic.js';
import { collectKuaishouVideoFields } from './kuaishou.js';
import { collectWechatVideoFields } from './wechat.js';

export async function collectPlatformEndpoints(
  page,
  finalUrl,
  platform,
  itemId,
  candidates,
  content,
  collectContentData
) {
  if (platform === 'douyin' && itemId) {
    await collectDouyinDetailEndpoint(page, itemId, candidates, content, collectContentData);
  } else if (platform === 'bilibili') {
    await collectBilibiliEndpoints(page, finalUrl, itemId, candidates, content, collectContentData);
  }
}

export function collectPlatformVideoFields(value, source, candidates, content) {
  if (content.platform === 'douyin') {
    collectDouyinVideoFields(value, source, candidates, content);
  } else if (content.platform === 'bilibili') {
    collectBilibiliVideoFields(value, source, candidates, content);
  } else if (content.platform === 'kuaishou') {
    collectKuaishouVideoFields(value, source, candidates, content);
  } else if (content.platform === 'wechat_channels') {
    collectWechatVideoFields(value, source, candidates, content);
  } else {
    collectGenericVideoFields(value, source, candidates, content);
  }
}
