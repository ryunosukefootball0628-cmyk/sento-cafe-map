// 記録データ（Spot）は localStorage のキー spots に JSON 配列で保存する
const SPOTS_KEY = 'spots';
// 記録シートの「種類」の初期値に使う、前回選んだ種類
const LAST_TYPE_KEY = 'lastType';
// 最後にバックアップを書き出した日時
const LAST_BACKUP_KEY = 'lastBackupAt';

function loadSpots() {
  const json = localStorage.getItem(SPOTS_KEY);
  return json === null ? [] : JSON.parse(json);
}

function saveSpots(spots) {
  localStorage.setItem(SPOTS_KEY, JSON.stringify(spots));
}

function loadLastType() {
  return localStorage.getItem(LAST_TYPE_KEY);
}

function saveLastType(type) {
  localStorage.setItem(LAST_TYPE_KEY, type);
}

function loadLastBackupAt() {
  return localStorage.getItem(LAST_BACKUP_KEY);
}

function saveLastBackupAt(dateTime) {
  localStorage.setItem(LAST_BACKUP_KEY, dateTime);
}

// ---- 写真（Photo）は IndexedDB のストア photos に保存する ----

const DB_NAME = 'sento-cafe-map';
const PHOTOS_STORE = 'photos';
let dbPromise = null;

function openDb() {
  if (dbPromise === null) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      // 初めて開いたときにストアを作る
      request.onupgradeneeded = () => {
        request.result.createObjectStore(PHOTOS_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

// 写真ストアで1回分の読み書きをして、書き込みが終わるまで待つ
async function usePhotoStore(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PHOTOS_STORE, mode);
    const request = action(transaction.objectStore(PHOTOS_STORE));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function loadPhoto(id) {
  return usePhotoStore('readonly', (store) => store.get(id));
}

function loadAllPhotos() {
  return usePhotoStore('readonly', (store) => store.getAll());
}

function savePhotos(photos) {
  return usePhotoStore('readwrite', (store) => {
    photos.forEach((photo) => store.put(photo));
  });
}

function deletePhotos(ids) {
  return usePhotoStore('readwrite', (store) => {
    ids.forEach((id) => store.delete(id));
  });
}
