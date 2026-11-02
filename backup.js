// バックアップ（JSONファイル）の作成と読み込み。写真は Base64（data URL）にして同じファイルに入れる
const BACKUP_APP = 'sento-cafe-map';
const BACKUP_VERSION = 1;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function createBackup(spots, exportedAt) {
  // 記録から使われている写真だけを入れる
  const usedIds = new Set(spots.flatMap((spot) => spot.photoIds));
  const photos = (await loadAllPhotos()).filter((photo) => usedIds.has(photo.id));
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt,
    spots,
    photos: await Promise.all(photos.map(async (photo) => ({
      id: photo.id,
      spotId: photo.spotId,
      dataUrl: await blobToDataUrl(photo.blob),
    }))),
  };
}

// 記録として最低限の形になっているか（種類は app.js の TYPE_LABELS と同じ）
function isValidSpot(spot) {
  return typeof spot?.id === 'string'
    && ['sento', 'cafe'].includes(spot.type)
    && typeof spot.name === 'string'
    && Number.isFinite(spot.lat)
    && Number.isFinite(spot.lng)
    && /^\d{4}-\d{2}-\d{2}$/.test(spot.visitedAt)
    && Array.isArray(spot.photoIds);
}

// 写真は data:image/ で始まるものだけを受け付ける（外部のURLを読みに行かないように）
function isValidPhoto(photo) {
  return typeof photo?.id === 'string'
    && typeof photo.dataUrl === 'string'
    && photo.dataUrl.startsWith('data:image/');
}

// 読み込んだファイルの中身を確かめて、記録と写真（Blob）に戻す
async function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み込めません');
  }
  if (data?.app !== BACKUP_APP || !Array.isArray(data.spots) || !Array.isArray(data.photos)) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  if (!data.spots.every(isValidSpot) || !data.photos.every(isValidPhoto)) {
    throw new Error('ファイルの中身が壊れています');
  }

  return {
    exportedAt: data.exportedAt,
    // 足りない項目があれば空の値で補う
    spots: data.spots.map((spot) => ({
      rating: null,
      comment: '',
      extra: {},
      createdAt: spot.visitedAt,
      updatedAt: spot.visitedAt,
      ...spot,
    })),
    photos: await Promise.all(data.photos.map(async (photo) => ({
      id: photo.id,
      spotId: photo.spotId,
      blob: await dataUrlToBlob(photo.dataUrl),
    }))),
  };
}

// 文字列をファイルとして端末に保存（ダウンロード）する
function downloadFile(fileName, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // ダウンロードが始まるまで少し待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
