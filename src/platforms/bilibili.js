import { collectGenericVideoFields } from './generic.js';

export async function collectBilibiliEndpoints(page, finalUrl, itemId, candidates, content, collectContentData) {
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

export function collectBilibiliVideoFields(value, source, candidates) {
  collectGenericVideoFields(value, source, candidates);
}
