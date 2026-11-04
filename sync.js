// 端末どうしの同期。Googleでログインすると、記録と写真を Firestore の users/{ログインした人のID}/ に置いて、
// ほかの端末と同じ内容にする。端末の中（localStorage / IndexedDB）にもこれまでどおり保存するので、電波がなくても記録できる
//   users/{uid}/spots/{記録のID}  … 記録。消した記録は { id, deleted: true, updatedAt } だけを残す
//   users/{uid}/photos/{写真のID} … 写真（{ spotId, dataUrl }。1枚およそ130KBで、1件の上限1MBに収まる）
// 同じ記録が両方で変わっていたら、updatedAt（消した記録は消した日時）が新しいほうを残す
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDoc, onSnapshot, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCf7MN7JOswnr0k67lMEjELwz9KT6HOqD0',
  authDomain: 'sentomap.firebaseapp.com',
  projectId: 'sentomap',
  storageBucket: 'sentomap.firebasestorage.app',
  messagingSenderId: '523246936383',
  appId: '1:523246936383:web:95856e75a7eda7bf8e738a',
};
// 公開サイトでは、ログインの画面も同じドメインで開く（Safari などでログインが途切れないように）
if (['sentomap.web.app', 'sentomap.firebaseapp.com'].includes(location.hostname)) {
  firebaseConfig.authDomain = location.hostname;
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Firestore 側も端末に控えを持つ。電波がないときに送れなかった分は、つながったときに送られる
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  ignoreUndefinedProperties: true,
});
// 開発用：http://localhost:8000/?emulator で開くと、本番ではなく手元のエミュレーター（npx firebase-tools emulators:start）を使う
if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulator')) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const syncSection = document.getElementById('sync-section');
const syncStatusEl = document.getElementById('sync-status');
const signInButton = document.getElementById('sign-in-button');
const signOutButton = document.getElementById('sign-out-button');

let uid = null;
let unsubscribe = null;
// サーバーの内容と一度突き合わせるまでは、変更を送らない（古い控えで新しい記録を上書きしないように）
let reconciled = false;

const spotDoc = (id) => doc(db, 'users', uid, 'spots', id);
const photoDoc = (id) => doc(db, 'users', uid, 'photos', id);
const timeOf = (dateTime) => (dateTime ? Date.parse(dateTime) : -Infinity);

// ---- 送った写真の控え（写真は作ったあと変わらないので、一度送れば送り直さなくてよい） ----

function syncedPhotosKey() {
  return `syncedPhotos:${uid}`;
}

function loadSyncedPhotos() {
  const json = localStorage.getItem(syncedPhotosKey());
  return new Set(json === null ? [] : JSON.parse(json));
}

function markPhotosSynced(ids) {
  if (ids.length === 0) {
    return;
  }
  const synced = loadSyncedPhotos();
  ids.forEach((id) => synced.add(id));
  localStorage.setItem(syncedPhotosKey(), JSON.stringify([...synced]));
}

// ---- 送る ----

// 1件の記録を、まだ送っていない写真と一緒に送る（写真が届く前に記録だけ届かないよう、まとめて書き込む）
async function pushSpot(spot, removedPhotoIds = []) {
  const synced = loadSyncedPhotos();
  const batch = writeBatch(db);
  const sentPhotoIds = [];
  for (const id of spot.photoIds.filter((photoId) => !synced.has(photoId))) {
    const photo = await loadPhoto(id);
    if (photo) {
      batch.set(photoDoc(id), { spotId: spot.id, dataUrl: await blobToDataUrl(photo.blob) });
      sentPhotoIds.push(id);
    }
  }
  removedPhotoIds.forEach((id) => batch.delete(photoDoc(id)));
  batch.set(spotDoc(spot.id), { ...spot, deleted: false });
  // 電波がないときは、つながって送れるまで終わらない
  await batch.commit();
  markPhotosSynced(sentPhotoIds);
}

async function pushDeletion(id, deletedAt, photoIds) {
  const batch = writeBatch(db);
  photoIds.forEach((photoId) => batch.delete(photoDoc(photoId)));
  batch.set(spotDoc(id), { id, deleted: true, updatedAt: deletedAt });
  await batch.commit();
}

function logError(error) {
  console.error(error);
}

// この端末で記録が変わったとき（app.js の commitSpots から呼ぶ）
function pushChanges(previous, nextSpots) {
  if (uid === null || !reconciled) {
    return;
  }
  const before = new Map(previous.map((spot) => [spot.id, spot]));
  const nextIds = new Set(nextSpots.map((spot) => spot.id));
  const deletedSpots = loadDeletedSpots();

  nextSpots.forEach((spot) => {
    const old = before.get(spot.id);
    if (old !== spot) {
      const removedPhotoIds = (old?.photoIds ?? []).filter((id) => !spot.photoIds.includes(id));
      pushSpot(spot, removedPhotoIds).catch(logError);
    }
  });
  previous.filter((spot) => !nextIds.has(spot.id)).forEach((spot) => {
    pushDeletion(spot.id, deletedSpots[spot.id] ?? spot.updatedAt, spot.photoIds).catch(logError);
  });
}

// ---- 受け取る ----

// 端末にない写真を取ってくる
async function downloadMissingPhotos(spotList) {
  let downloaded = false;
  for (const spot of spotList) {
    for (const id of spot.photoIds) {
      if (await loadPhoto(id)) {
        continue;
      }
      const snapshot = await getDoc(photoDoc(id));
      if (snapshot.exists()) {
        const { spotId, dataUrl } = snapshot.data();
        await savePhotos([{ id, spotId, blob: await dataUrlToBlob(dataUrl) }]);
        markPhotosSynced([id]);
        downloaded = true;
      }
    }
  }
  if (downloaded) {
    renderList();
    if (detailId !== null && findSpot(detailId)) {
      renderDetail(findSpot(detailId));
    }
  }
}

// サーバーの記録（remoteDocs）と端末の記録を突き合わせる。
// full のときは全件がそろっているので、サーバーにない端末の記録を送る
function merge(remoteDocs, full) {
  const deletedSpots = loadDeletedSpots();
  const byId = new Map(spots.map((spot) => [spot.id, spot]));
  const received = [];
  const unusedPhotoIds = [];
  let changed = false;

  remoteDocs.forEach((remote) => {
    const local = byId.get(remote.id);
    const localTime = timeOf(local ? local.updatedAt : deletedSpots[remote.id]);
    const remoteTime = timeOf(remote.updatedAt);

    if (remoteTime > localTime) {
      // サーバーのほうが新しい
      if (remote.deleted) {
        if (local) {
          byId.delete(remote.id);
          unusedPhotoIds.push(...local.photoIds);
          changed = true;
        }
        deletedSpots[remote.id] = remote.updatedAt;
      } else {
        const { deleted, ...spot } = remote;
        const next = normalizeSpot(spot);
        byId.set(remote.id, next);
        unusedPhotoIds.push(...(local?.photoIds ?? []).filter((id) => !next.photoIds.includes(id)));
        delete deletedSpots[remote.id];
        received.push(next);
        changed = true;
      }
    } else if (localTime > remoteTime) {
      // 端末のほうが新しい
      if (local) {
        const removedPhotoIds = (remote.photoIds ?? []).filter((id) => !local.photoIds.includes(id));
        pushSpot(local, removedPhotoIds).catch(logError);
      } else if (!remote.deleted) {
        pushDeletion(remote.id, deletedSpots[remote.id], remote.photoIds ?? []).catch(logError);
      }
    }
  });

  if (full) {
    const remoteIds = new Set(remoteDocs.map((remote) => remote.id));
    spots.filter((spot) => !remoteIds.has(spot.id)).forEach((spot) => pushSpot(spot).catch(logError));
  }

  saveDeletedSpots(deletedSpots);
  if (changed) {
    applySyncedSpots([...byId.values()]);
    deletePhotos(unusedPhotoIds).catch(logError);
  }
  downloadMissingPhotos(received).catch(logError);
}

function startSync() {
  reconciled = false;
  unsubscribe = onSnapshot(collection(db, 'users', uid, 'spots'), { includeMetadataChanges: true }, (snapshot) => {
    // 端末の控えだけの内容（電波がないときなど）では突き合わせない
    if (snapshot.metadata.fromCache) {
      return;
    }
    if (!reconciled) {
      reconciled = true;
      merge(snapshot.docs.map((remote) => remote.data()), true);
    } else {
      // この端末から送った書き込みは、もう反映済みなので飛ばす
      const changes = snapshot.docChanges()
        .filter((change) => change.type !== 'removed' && !change.doc.metadata.hasPendingWrites)
        .map((change) => change.doc.data());
      if (changes.length > 0) {
        merge(changes, false);
      }
    }
    renderSyncStatus();
  }, (error) => {
    logError(error);
    syncStatusEl.textContent = '同期できませんでした。時間をおいて開き直してください';
  });
}

function stopSync() {
  unsubscribe?.();
  unsubscribe = null;
  reconciled = false;
}

// ---- ログイン ----

function renderSyncStatus() {
  const user = auth.currentUser;
  signInButton.hidden = user !== null;
  signOutButton.hidden = user === null;
  if (user === null) {
    syncStatusEl.textContent = 'ログインしていません（この端末だけに保存しています）';
  } else if (!reconciled) {
    syncStatusEl.textContent = `${user.email} でログイン中（電波がつながると同期します）`;
  } else {
    syncStatusEl.textContent = `${user.email} で同期しています`;
  }
}

function showSignInError(error) {
  logError(error);
  if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
    return;
  }
  alert(`ログインできませんでした（${error.code ?? error.message}）`);
}

signInButton.addEventListener('click', () => {
  const provider = new GoogleAuthProvider();
  // ホーム画面から開いたアプリでは別の窓を開けないことがあるので、画面ごと移動してログインする
  if (isStandalone) {
    signInWithRedirect(auth, provider).catch(showSignInError);
  } else {
    signInWithPopup(auth, provider).catch(showSignInError);
  }
});

signOutButton.addEventListener('click', () => {
  if (confirm('ログアウトしますか？\nこの端末の記録はそのまま残ります。ほかの端末との同期は止まります。')) {
    signOut(auth).catch(logError);
  }
});

getRedirectResult(auth).catch(showSignInError);

onAuthStateChanged(auth, (user) => {
  stopSync();
  uid = user?.uid ?? null;
  if (uid !== null) {
    startSync();
  }
  renderSyncStatus();
});

syncSection.hidden = false;
window.cloudSync = { pushChanges };
