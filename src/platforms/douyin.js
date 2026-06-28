import { collectGenericVideoFields } from './generic.js';

export async function collectDouyinDetailEndpoint(page, awemeId, candidates, content, collectContentData) {
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

export function collectDouyinVideoFields(value, source, candidates) {
  collectGenericVideoFields(value, source, candidates);
}
