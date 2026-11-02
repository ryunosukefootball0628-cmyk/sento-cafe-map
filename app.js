// 位置情報が使えないときに表示する場所（設計書のJSON例と同じ大阪市内）
const DEFAULT_CENTER = [34.69, 135.5];
const DEFAULT_ZOOM = 13;
// 現在地が取れたときのズーム（周りのお店が見分けられる程度）
const CURRENT_ZOOM = 17;

const TYPE_LABELS = { sento: '銭湯', cafe: 'カフェ' };
// ピンの色。現在地の青い点と見分けやすい色にする（style.css の .type-sento / .type-cafe と同じ）
const TYPE_COLORS = { sento: '#0e7490', cafe: '#b45309' };
// 写真がない記録のリストに出す印
const TYPE_ICONS = { sento: '♨️', cafe: '☕' };

// 1件の記録に付けられる写真の枚数
const MAX_PHOTOS = 3;
// 最後のバックアップからこの日数がたったら知らせる
const BACKUP_REMIND_DAYS = 30;

const map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);

// OSMの出典表示は attribution に書いた文言が右下に出る（書かないと表示されない）
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
let toastTimer = null;

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

// 保存できたことなどを数秒だけ知らせる
function showToast(message, duration = 3000) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
}

// ---- 日付とID ----

const pad = (number) => String(number).padStart(2, '0');

// 端末のローカル時刻で YYYY-MM-DD を作る（toISOString() はUTCなので、0〜9時に前日になる）
function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 端末のローカル時刻で「2026-10-30T19:12:00+09:00」の形にする
function formatLocalDateTime(date) {
  const offset = -date.getTimezoneOffset(); // UTCとの差（分）。日本なら540
  const sign = offset >= 0 ? '+' : '-';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${formatLocalDate(date)}T${time}${zone}`;
}

function randomHex(byteLength) {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// 記録のID（日時＋乱数）。例：20261102-193512-a1b2
function createId(date) {
  const day = formatLocalDate(date).replaceAll('-', '');
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${randomHex(2)}`;
}

// 写真のID。例：p-3f9a1c0b7d2e4a65
function createPhotoId() {
  return `p-${randomHex(8)}`;
}

// 画面に出す日付（2026-11-02 → 2026年11月2日）
function formatDisplayDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function formatStars(rating) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

// ---- 現在地 ----
// 「＋ ここを記録」を押したときに待たずに済むよう、起動時から位置を取り続ける

let lastPosition = null; // 最新の現在地 [緯度, 経度]
let currentMarker = null;

function handlePosition(position) {
  const latlng = [position.coords.latitude, position.coords.longitude];

  // 最初に取れたときだけ現在地へ移動する（その後は地図を動かしても引き戻さない）
  if (lastPosition === null) {
    map.setView(latlng, CURRENT_ZOOM);
  }
  lastPosition = latlng;

  if (currentMarker === null) {
    currentMarker = L.circleMarker(latlng, {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#1a73e8',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    currentMarker.setLatLng(latlng);
  }

  hideStatus();
}

function handlePositionError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    showStatus('位置情報が許可されていません。ブラウザの設定で許可すると現在地を表示します');
    return;
  }
  // 一度取れていれば、一時的な失敗は知らせずにそのまま取り続ける
  if (lastPosition === null) {
    showStatus('現在地をまだ取得できていません。取れしだい移動します');
  }
}

if (!window.isSecureContext) {
  showStatus('位置情報は https か localhost で開いたときだけ使えます');
} else if ('geolocation' in navigator) {
  showStatus('現在地を取得しています…');
  navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 15000,
  });
} else {
  showStatus('このブラウザでは現在地を取得できません');
}

// 現在地ボタン：地図を動かしたあとに現在地へ戻る
document.getElementById('locate-button').addEventListener('click', () => {
  if (lastPosition === null) {
    showToast('現在地をまだ取得できていません');
    return;
  }
  map.setView(lastPosition, Math.max(map.getZoom(), CURRENT_ZOOM));
});

// ---- 記録データ ----

let spots = loadSpots();

function findSpot(id) {
  return spots.find((spot) => spot.id === id);
}

// 保存できたときだけ、画面側のデータも差し替えて表示し直す
function commitSpots(nextSpots) {
  try {
    saveSpots(nextSpots);
  } catch (error) {
    console.error(error);
    alert('保存できませんでした。もう一度お試しください');
    return false;
  }
  spots = nextSpots;
  renderList();
  renderSettings();
  return true;
}

function saveUpdatedSpot(updated) {
  return commitSpots(spots.map((spot) => (spot.id === updated.id ? updated : spot)));
}

// ---- 記録のピン ----

const markers = new Map(); // 記録のID → ピン

function spotIcon(type) {
  return L.divIcon({
    className: 'spot-pin',
    html: `<svg width="28" height="40" viewBox="0 0 28 40" aria-hidden="true">
      <path d="M14 1.5C7.1 1.5 1.5 7.1 1.5 14c0 9.5 12.5 24.5 12.5 24.5S26.5 23.5 26.5 14c0-6.9-5.6-12.5-12.5-12.5Z"
        fill="${TYPE_COLORS[type]}" stroke="#ffffff" stroke-width="2"/>
      <circle cx="14" cy="14" r="5" fill="#ffffff"/>
    </svg>`,
    iconSize: [28, 40],
    iconAnchor: [14, 39],
    popupAnchor: [0, -34],
  });
}

function addSpotMarker(spot) {
  const marker = L.marker([spot.lat, spot.lng], { icon: spotIcon(spot.type), title: spot.name })
    .addTo(map)
    .on('click', () => {
      // 位置を直している間は詳細画面を開かない
      if (movingId === null) {
        openDetail(spot.id);
      }
    });
  markers.set(spot.id, marker);
}

function removeSpotMarker(id) {
  markers.get(id).remove();
  markers.delete(id);
}

function renderMarkers() {
  markers.forEach((marker) => marker.remove());
  markers.clear();
  spots.forEach(addSpotMarker);
}

// ---- 画面の切り替え（地図・リスト・設定） ----

const listView = document.getElementById('list-view');
const settingsView = document.getElementById('settings-view');
const tabs = document.querySelectorAll('.tab');

function showView(view) {
  document.body.dataset.view = view;
  listView.hidden = view !== 'list';
  settingsView.hidden = view !== 'settings';
  tabs.forEach((tab) => {
    if (tab.dataset.view === view) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  });
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
});

// ---- リスト画面 ----

const listTitle = document.getElementById('list-title');
const listEmpty = document.getElementById('list-empty');
const spotList = document.getElementById('spot-list');
let listPhotoUrls = []; // リストの写真の表示に使っている URL（作り直すときに解放する）
let listRenderCount = 0;

function renderList() {
  listPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
  listPhotoUrls = [];
  listRenderCount += 1;

  // 訪問日の新しい順。同じ日なら、あとに記録したものを上にする
  const sorted = [...spots].sort((a, b) =>
    b.visitedAt.localeCompare(a.visitedAt) || b.createdAt.localeCompare(a.createdAt));

  listTitle.textContent = `記録一覧（${spots.length}件）`;
  listEmpty.hidden = spots.length > 0;
  spotList.replaceChildren(...sorted.map(createListItem));
}

function createListThumb(spot) {
  if (spot.photoIds.length === 0) {
    const icon = document.createElement('span');
    icon.className = 'spot-row-thumb';
    icon.textContent = TYPE_ICONS[spot.type];
    return icon;
  }

  const image = document.createElement('img');
  image.className = 'spot-row-thumb';
  image.alt = '';
  // 1枚目の写真が読み込めたら表示する（その間にリストを作り直していたら使わない）
  const renderCount = listRenderCount;
  loadPhoto(spot.photoIds[0])
    .then((photo) => {
      if (photo && renderCount === listRenderCount) {
        const url = URL.createObjectURL(photo.blob);
        listPhotoUrls.push(url);
        image.src = url;
      }
    })
    .catch((error) => console.error(error));
  return image;
}

function createListItem(spot) {
  const name = document.createElement('span');
  name.className = 'spot-row-name';
  name.textContent = spot.name;

  const type = document.createElement('span');
  type.className = `type-${spot.type}`;
  type.textContent = TYPE_LABELS[spot.type];

  const meta = document.createElement('span');
  meta.className = 'spot-row-meta';
  meta.append(type, `・${formatDisplayDate(spot.visitedAt)}`);

  const main = document.createElement('span');
  main.className = 'spot-row-main';
  main.append(name, meta);

  const rating = document.createElement('span');
  rating.className = 'spot-row-rating';
  rating.textContent = spot.rating ? formatStars(spot.rating) : '';

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'spot-row';
  row.append(createListThumb(spot), main, rating);
  row.addEventListener('click', () => openDetail(spot.id));

  const item = document.createElement('li');
  item.append(row);
  return item;
}

// ---- 詳細画面 ----

const detailView = document.getElementById('detail-view');
const detailPhotos = document.getElementById('detail-photos');
const detailType = document.getElementById('detail-type');
const detailName = document.getElementById('detail-name');
const detailDate = document.getElementById('detail-date');
const detailRating = document.getElementById('detail-rating');
const detailComment = document.getElementById('detail-comment');

let detailId = null; // 詳細画面で表示中の記録のID
let detailPhotoUrls = [];
let detailPhotoRequest = 0;

function clearDetailPhotos() {
  detailPhotoRequest += 1; // 読み込み中の写真があれば使わない
  detailPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
  detailPhotoUrls = [];
  detailPhotos.replaceChildren();
}

async function renderDetailPhotos(spot) {
  clearDetailPhotos();
  detailPhotos.hidden = spot.photoIds.length === 0;
  if (spot.photoIds.length === 0) {
    return;
  }

  const request = detailPhotoRequest;
  let photos;
  try {
    photos = (await Promise.all(spot.photoIds.map((id) => loadPhoto(id)))).filter(Boolean);
  } catch (error) {
    console.error(error);
    return;
  }
  if (request !== detailPhotoRequest) {
    return; // 読み込んでいる間に、閉じたか別の記録を開いた
  }

  detailPhotoUrls = photos.map((photo) => URL.createObjectURL(photo.blob));
  detailPhotos.replaceChildren(...detailPhotoUrls.map((url, index) => {
    const image = document.createElement('img');
    image.src = url;
    image.alt = `写真${index + 1}`;
    return image;
  }));
}

function renderDetail(spot) {
  detailType.className = `type-badge type-${spot.type}`;
  detailType.textContent = TYPE_LABELS[spot.type];
  // 店名や感想は textContent で入れる（HTMLとして解釈させない）
  detailName.textContent = spot.name;
  detailDate.textContent = formatDisplayDate(spot.visitedAt);
  detailRating.className = spot.rating ? 'stars' : 'muted';
  detailRating.textContent = spot.rating ? formatStars(spot.rating) : '未評価';
  detailComment.classList.toggle('is-empty', spot.comment === '');
  detailComment.textContent = spot.comment || '感想はまだありません';
  renderDetailPhotos(spot);
}

function openDetail(id) {
  detailId = id;
  renderDetail(findSpot(id));
  detailView.hidden = false;
  detailView.scrollTop = 0;
  document.getElementById('detail-back').focus();
}

function closeDetail() {
  detailId = null;
  detailView.hidden = true;
  clearDetailPhotos();
}

function deleteSpot(id) {
  const spot = findSpot(id);
  if (!confirm(`「${spot.name}」を削除しますか？\nこの操作は取り消せません。`)) {
    return;
  }
  if (!commitSpots(spots.filter((other) => other.id !== id))) {
    return;
  }
  // 記録に紐づく写真も消す
  deletePhotos(spot.photoIds).catch((error) => console.error(error));

  removeSpotMarker(id);
  closeDetail();
  showToast(`「${spot.name}」を削除しました`);
}

document.getElementById('detail-back').addEventListener('click', closeDetail);
document.getElementById('detail-edit').addEventListener('click', () => openSheet(findSpot(detailId)));
document.getElementById('detail-delete').addEventListener('click', () => deleteSpot(detailId));
document.getElementById('detail-move').addEventListener('click', () => startMove(detailId));

// ---- ピンの位置を直す ----
// 地図を動かすつもりで誤ってピンを動かさないよう、詳細画面から始めたときだけドラッグできる

const moveBar = document.getElementById('move-bar');
let movingId = null; // 位置を直している記録のID
let moveFrom = null; // キャンセルしたときに戻す位置

function startMove(id) {
  const marker = markers.get(id);
  movingId = id;
  moveFrom = marker.getLatLng();

  closeDetail();
  showView('map');
  map.setView(moveFrom, Math.max(map.getZoom(), CURRENT_ZOOM));
  marker.dragging.enable();
  document.body.classList.add('is-moving');
  moveBar.hidden = false;
}

function endMove() {
  markers.get(movingId).dragging.disable();
  movingId = null;
  moveFrom = null;
  document.body.classList.remove('is-moving');
  moveBar.hidden = true;
}

document.getElementById('move-cancel').addEventListener('click', () => {
  markers.get(movingId).setLatLng(moveFrom);
  endMove();
});

document.getElementById('move-done').addEventListener('click', () => {
  const { lat, lng } = markers.get(movingId).getLatLng();
  const spot = findSpot(movingId);
  if (!saveUpdatedSpot({ ...spot, lat, lng, updatedAt: formatLocalDateTime(new Date()) })) {
    return;
  }
  endMove();
  showToast(`「${spot.name}」の位置を直しました`);
});

// ---- 記録シート（新規記録と編集で共用） ----

const recordButton = document.getElementById('record-button');
const sheet = document.getElementById('record-sheet');
const sheetTitle = document.getElementById('sheet-title');
const nameInput = document.getElementById('name-input');
const visitedField = document.getElementById('visited-field');
const visitedInput = document.getElementById('visited-input');
const commentInput = document.getElementById('comment-input');
const ratingButtons = sheet.querySelectorAll('.rating button');
const photoThumbs = document.getElementById('photo-thumbs');
const cameraButton = document.getElementById('camera-button');
const albumButton = document.getElementById('album-button');
const cameraInput = document.getElementById('camera-input');
const albumInput = document.getElementById('album-input');
const saveButton = document.getElementById('save-button');

let editingId = null; // 編集中の記録のID（新規記録のときは null）
let draftLatLng = null; // 新規記録の位置（「＋ ここを記録」を押した時点で決める）
let draftUsesMapCenter = false;
let draftRating = null;
let draftPhotos = []; // シートに付けている写真 { id, blob, url, isNew }
let removedPhotoIds = []; // 編集で外した、保存済みの写真のID
let pendingPhotos = 0; // 読み込み中・縮小中の写真の枚数（この間は保存できない）
let sheetSession = 0; // シートを開くたびに増やす（閉じたあとに届いた写真を捨てるため）
let saving = false;

function setRating(value) {
  draftRating = value;
  ratingButtons.forEach((button) => {
    const buttonValue = Number(button.dataset.value);
    button.classList.toggle('is-on', value !== null && buttonValue <= value);
    button.setAttribute('aria-pressed', String(buttonValue === value));
  });
}

function setType(type) {
  sheet.querySelector(`input[name="type"][value="${type}"]`).checked = true;
}

function createDraftThumb(photo) {
  const image = document.createElement('img');
  image.src = photo.url;
  image.alt = '';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'photo-remove';
  remove.setAttribute('aria-label', '写真を外す');
  remove.textContent = '×';
  remove.addEventListener('click', () => removeDraftPhoto(photo));

  const item = document.createElement('li');
  item.className = 'photo-thumb';
  item.append(image, remove);
  return item;
}

function renderDraftPhotos() {
  photoThumbs.replaceChildren(...draftPhotos.map(createDraftThumb));
  const full = draftPhotos.length + pendingPhotos >= MAX_PHOTOS;
  cameraButton.disabled = full;
  albumButton.disabled = full;
  saveButton.disabled = saving || pendingPhotos > 0;
  saveButton.textContent = pendingPhotos > 0 ? '写真を準備しています…' : '保存';
}

function removeDraftPhoto(photo) {
  URL.revokeObjectURL(photo.url);
  draftPhotos = draftPhotos.filter((other) => other !== photo);
  if (!photo.isNew) {
    removedPhotoIds.push(photo.id);
  }
  renderDraftPhotos();
}

function clearDraftPhotos() {
  draftPhotos.forEach((photo) => URL.revokeObjectURL(photo.url));
  draftPhotos = [];
  removedPhotoIds = [];
  pendingPhotos = 0;
}

// 撮影・アルバムで選んだ写真を縮小して、シートに付ける
async function addPhotoFiles(files) {
  const session = sheetSession;
  const room = MAX_PHOTOS - draftPhotos.length - pendingPhotos;
  if (files.length > room) {
    showToast(`写真は1件につき${MAX_PHOTOS}枚までです`);
  }
  const accepted = files.slice(0, room);
  pendingPhotos += accepted.length;
  renderDraftPhotos();

  for (const file of accepted) {
    let blob = null;
    try {
      blob = await compressPhoto(file);
    } catch (error) {
      console.error(error);
      showToast('写真を読み込めませんでした');
    }
    if (session !== sheetSession) {
      return; // 縮小している間にシートが閉じられた
    }
    pendingPhotos -= 1;
    if (blob) {
      draftPhotos.push({ id: createPhotoId(), blob, url: URL.createObjectURL(blob), isNew: true });
    }
    renderDraftPhotos();
  }
}

// 編集するときは、保存済みの写真を読み込んでシートに並べる
async function loadDraftPhotos(photoIds) {
  const session = sheetSession;
  pendingPhotos += photoIds.length;
  renderDraftPhotos();

  let photos;
  try {
    photos = (await Promise.all(photoIds.map((id) => loadPhoto(id)))).filter(Boolean);
  } catch (error) {
    console.error(error);
    if (session === sheetSession) {
      // 写真を読めないまま保存すると写真が外れてしまうので、編集をやめる
      alert('写真を読み込めませんでした。もう一度開いてください');
      closeSheet();
    }
    return;
  }
  if (session !== sheetSession) {
    return;
  }

  pendingPhotos -= photoIds.length;
  const saved = photos.map((photo) => ({
    id: photo.id,
    blob: photo.blob,
    url: URL.createObjectURL(photo.blob),
    isNew: false,
  }));
  draftPhotos = [...saved, ...draftPhotos];
  renderDraftPhotos();
}

// spot を渡すと編集、渡さないと新規記録としてシートを開く
function openSheet(spot = null) {
  // 起動時のお知らせなどがシートの入力欄に重ならないよう消しておく
  hideToast();
  sheet.reset();
  sheetSession += 1;
  clearDraftPhotos();
  saving = false;
  editingId = spot ? spot.id : null;
  sheetTitle.textContent = spot ? '記録を編集' : '記録する';
  // 訪問日は編集のときだけ変えられる（新規記録は保存した日付が自動で入る）
  visitedField.hidden = !spot;

  if (spot) {
    setType(spot.type);
    nameInput.value = spot.name;
    visitedInput.value = spot.visitedAt;
    setRating(spot.rating);
    commentInput.value = spot.comment;
  } else {
    // 押した時点の最新の現在地を使う。取れていなければ地図の中心で記録し、あとでピンを動かして直す
    draftUsesMapCenter = lastPosition === null;
    if (draftUsesMapCenter) {
      const center = map.getCenter();
      draftLatLng = [center.lat, center.lng];
    } else {
      draftLatLng = lastPosition;
    }
    // 種類は前回選んだものを初期値にする
    const lastType = loadLastType();
    setType(Object.keys(TYPE_LABELS).includes(lastType) ? lastType : 'sento');
    setRating(null);
  }

  renderDraftPhotos();
  if (spot) {
    loadDraftPhotos(spot.photoIds);
  }

  sheet.classList.add('is-open');
  // 新規記録のときは、すぐに店名を打てるようにする
  if (!spot) {
    nameInput.focus({ preventScroll: true });
  }
}

function closeSheet() {
  sheet.classList.remove('is-open');
  sheetSession += 1; // 縮小中・読み込み中の写真は捨てる
  clearDraftPhotos();
  // 入力中ならキーボードを閉じる
  if (sheet.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}

recordButton.addEventListener('click', () => openSheet());
document.getElementById('sheet-close').addEventListener('click', closeSheet);

ratingButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const value = Number(button.dataset.value);
    // 同じ星をもう一度押すと「評価なし」に戻す
    setRating(value === draftRating ? null : value);
  });
});

cameraButton.addEventListener('click', () => cameraInput.click());
albumButton.addEventListener('click', () => albumInput.click());
[cameraInput, albumInput].forEach((input) => {
  input.addEventListener('change', () => {
    addPhotoFiles([...input.files]);
    // 同じ写真をもう一度選んでも反応するように空にする
    input.value = '';
  });
});

// 店名の入力中に Enter（完了）を押したら、保存はせずにキーボードだけ閉じる
nameInput.addEventListener('keydown', (event) => {
  // 日本語の変換を確定する Enter は除く（Safariでは isComposing が false になるため keyCode も見る）
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) {
    return;
  }
  event.preventDefault();
  nameInput.blur();
});

sheet.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving || pendingPhotos > 0) {
    return;
  }

  const name = nameInput.value.trim();
  if (name === '') {
    // 空白だけの店名は未入力として扱う
    nameInput.value = '';
    nameInput.reportValidity();
    return;
  }

  // 保存している間にシートが閉じられても困らないよう、入力内容をここで取り出しておく
  const draft = {
    type: sheet.querySelector('input[name="type"]:checked').value,
    name,
    comment: commentInput.value.trim(),
    rating: draftRating,
    visitedAt: visitedInput.value,
    photos: [...draftPhotos],
    removedPhotoIds: [...removedPhotoIds],
    latlng: draftLatLng,
    usesMapCenter: draftUsesMapCenter,
  };
  saving = true;
  renderDraftPhotos();
  try {
    if (editingId === null) {
      await createSpot(draft);
    } else {
      await updateSpot(editingId, draft);
    }
  } finally {
    saving = false;
    renderDraftPhotos();
  }
});

// 新しく付けた写真を、記録より先に保存する（記録だけが写真のない状態で残らないように）
async function saveNewPhotos(spotId, photos) {
  const newPhotos = photos
    .filter((photo) => photo.isNew)
    .map((photo) => ({ id: photo.id, spotId, blob: photo.blob }));
  try {
    await savePhotos(newPhotos);
  } catch (error) {
    console.error(error);
    alert('写真を保存できませんでした。もう一度お試しください');
    return null;
  }
  return newPhotos.map((photo) => photo.id);
}

async function createSpot(draft) {
  const now = new Date();
  const id = createId(now);
  const newPhotoIds = await saveNewPhotos(id, draft.photos);
  if (newPhotoIds === null) {
    return;
  }

  const spot = {
    id,
    type: draft.type,
    name: draft.name,
    lat: draft.latlng[0],
    lng: draft.latlng[1],
    visitedAt: formatLocalDate(now),
    rating: draft.rating,
    comment: draft.comment,
    photoIds: draft.photos.map((photo) => photo.id),
    extra: {},
    createdAt: formatLocalDateTime(now),
    updatedAt: formatLocalDateTime(now),
  };
  if (!commitSpots([...spots, spot])) {
    // 記録を保存できなかったので、先に入れた写真を消す
    deletePhotos(newPhotoIds).catch((error) => console.error(error));
    return;
  }
  saveLastType(draft.type);

  addSpotMarker(spot);
  closeSheet();
  if (!map.getBounds().contains(draft.latlng)) {
    map.panTo(draft.latlng);
  }

  const message = draft.usesMapCenter
    ? `現在地が取れないため、地図の中心に「${draft.name}」を記録しました`
    : `「${draft.name}」を記録しました`;
  showToast(message);
}

async function updateSpot(id, draft) {
  const newPhotoIds = await saveNewPhotos(id, draft.photos);
  if (newPhotoIds === null) {
    return;
  }

  const spot = findSpot(id);
  const updated = {
    ...spot,
    type: draft.type,
    name: draft.name,
    // 訪問日が空にされたときは元の日付のままにする
    visitedAt: draft.visitedAt || spot.visitedAt,
    rating: draft.rating,
    comment: draft.comment,
    photoIds: draft.photos.map((photo) => photo.id),
    updatedAt: formatLocalDateTime(new Date()),
  };
  if (!saveUpdatedSpot(updated)) {
    deletePhotos(newPhotoIds).catch((error) => console.error(error));
    return;
  }
  // 外した写真は、記録を保存できてから消す
  deletePhotos(draft.removedPhotoIds).catch((error) => console.error(error));

  // 種類や店名が変わったときのために、ピンを作り直す
  removeSpotMarker(id);
  addSpotMarker(updated);
  if (detailId === id) {
    renderDetail(updated);
  }
  closeSheet();
  showToast('保存しました');
}

// ---- 設定画面とバックアップ ----

const settingsTab = document.querySelector('.tab[data-view="settings"]');
const spotCountEl = document.getElementById('spot-count');
const lastBackupEl = document.getElementById('last-backup');
const backupWarning = document.getElementById('backup-warning');
const exportButton = document.getElementById('export-button');
const importInput = document.getElementById('import-input');
const importDialog = document.getElementById('import-dialog');
const importSummary = document.getElementById('import-summary');
let pendingBackup = null; // 読み込んだあと、追加か上書きかを選んでもらっているバックアップ

// 最後のバックアップ（一度もなければ、いちばん古い記録）から日数がたっているか
function isBackupOverdue() {
  if (spots.length === 0) {
    return false;
  }
  const since = loadLastBackupAt() ?? spots.map((spot) => spot.createdAt).sort()[0];
  const days = (Date.now() - Date.parse(since)) / (24 * 60 * 60 * 1000);
  return days >= BACKUP_REMIND_DAYS;
}

function renderSettings() {
  const photoCount = spots.reduce((sum, spot) => sum + spot.photoIds.length, 0);
  spotCountEl.textContent = `${spots.length}件（写真 ${photoCount}枚）`;
  const lastBackupAt = loadLastBackupAt();
  lastBackupEl.textContent = lastBackupAt ? formatDisplayDate(lastBackupAt.slice(0, 10)) : 'まだありません';

  const overdue = isBackupOverdue();
  backupWarning.hidden = !overdue;
  settingsTab.classList.toggle('has-alert', overdue);
}

async function exportBackup() {
  exportButton.disabled = true;
  try {
    const now = new Date();
    const backup = await createBackup(spots, formatLocalDateTime(now));
    downloadFile(`sento-cafe-map-backup-${formatLocalDate(now)}.json`, JSON.stringify(backup), 'application/json');
    saveLastBackupAt(formatLocalDateTime(now));
    renderSettings();
    showToast('バックアップを書き出しました。ファイルは大切に保管してください', 5000);
  } catch (error) {
    console.error(error);
    alert('バックアップを書き出せませんでした');
  } finally {
    exportButton.disabled = false;
  }
}

async function importBackup(mode, backup) {
  if (mode === 'replace' && spots.length > 0
    && !confirm(`今の記録（${spots.length}件）をすべて消して、バックアップの内容に置き換えます。よろしいですか？`)) {
    return;
  }

  // 「追加」のときは、同じIDの記録がすでにあれば飛ばす（今の記録を優先する）
  const existingIds = new Set(spots.map((spot) => spot.id));
  const incoming = mode === 'add'
    ? backup.spots.filter((spot) => !existingIds.has(spot.id))
    : backup.spots;
  const neededPhotoIds = new Set(incoming.flatMap((spot) => spot.photoIds));

  try {
    // 写真を先に入れてから記録を保存する
    await savePhotos(backup.photos.filter((photo) => neededPhotoIds.has(photo.id)));
  } catch (error) {
    console.error(error);
    alert('写真を保存できませんでした。もう一度お試しください');
    return;
  }

  const previous = spots;
  if (!commitSpots(mode === 'add' ? [...spots, ...incoming] : incoming)) {
    return;
  }
  if (mode === 'replace') {
    // 置き換えで使われなくなった写真を消す
    const kept = new Set(spots.flatMap((spot) => spot.photoIds));
    const unused = previous.flatMap((spot) => spot.photoIds).filter((id) => !kept.has(id));
    deletePhotos(unused).catch((error) => console.error(error));
  }
  renderMarkers();

  const skipped = backup.spots.length - incoming.length;
  if (mode === 'replace') {
    showToast(`${incoming.length}件の記録に置き換えました`);
  } else if (skipped > 0) {
    showToast(`${incoming.length}件を追加しました（${skipped}件はすでにあるため飛ばしました）`, 5000);
  } else {
    showToast(`${incoming.length}件を追加しました`);
  }
}

exportButton.addEventListener('click', exportBackup);
document.getElementById('import-button').addEventListener('click', () => importInput.click());

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) {
    return;
  }

  let backup;
  try {
    backup = await parseBackup(await file.text());
  } catch (error) {
    alert(`バックアップを読み込めませんでした。${error.message}`);
    return;
  }

  // 「追加」か「上書き」かを選んでもらう
  pendingBackup = backup;
  importSummary.textContent = `このファイルには ${backup.spots.length}件の記録（写真 ${backup.photos.length}枚）が入っています。`;
  importDialog.showModal();
});

// 押されたボタンの value（cancel / add / replace）で決める。ダイアログはそのまま閉じる
document.getElementById('import-form').addEventListener('submit', (event) => {
  const mode = event.submitter?.value;
  const backup = pendingBackup;
  pendingBackup = null;
  if (backup && (mode === 'add' || mode === 'replace')) {
    importBackup(mode, backup);
  }
});

// Esc キーで、いちばん上に開いている画面を閉じる（PCで使うとき用）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (sheet.classList.contains('is-open')) {
    closeSheet();
  } else if (!detailView.hidden) {
    closeDetail();
  }
});

// ---- 起動時 ----

renderMarkers();
renderList();
renderSettings();
if (isBackupOverdue()) {
  showToast(`最後のバックアップから${BACKUP_REMIND_DAYS}日以上たっています。設定から書き出してください`, 6000);
}
