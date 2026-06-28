import { firstString } from '../utils.js';
import { collectUrlList } from '../video-candidates.js';

export function collectKuaishouVideoFields(value, source, candidates, content) {
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
