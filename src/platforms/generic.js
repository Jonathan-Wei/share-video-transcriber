import { collectUrlList } from '../video-candidates.js';

export function collectGenericVideoFields(value, source, candidates) {
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
