// 撮影した写真を、長辺800px・JPEG品質0.7に縮小する（1枚およそ100KB）
const PHOTO_MAX_SIDE = 800;
const PHOTO_QUALITY = 0.7;

// <img> で読み込む（スマホ写真の向きの情報も反映される）
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    image.src = url;
  });
}

async function compressPhoto(file) {
  const image = await loadImage(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext('2d');
  // 透明な部分があるPNGでも黒くならないよう、白で塗ってから描く
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('画像を変換できませんでした'));
      }
    }, 'image/jpeg', PHOTO_QUALITY);
  });
}
