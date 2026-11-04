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
// 統計で、月ごとの訪問数を出す月数
const STATS_MONTHS = 12;

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

// 状態（status）がない古い記録は「行った」として扱う
function normalizeSpot(spot) {
  return { status: 'visited', extra: {}, ...spot };
}

let spots = loadSpots().map(normalizeSpot);

function findSpot(id) {
  return spots.find((spot) => spot.id === id);
}

// 消した記録を、消した日時とともに残す（ログインしていないときに消した分も、あとで同期できるように）
function recordDeletedSpots(previous, nextSpots) {
  const nextIds = new Set(nextSpots.map((spot) => spot.id));
  const removed = previous.filter((spot) => !nextIds.has(spot.id));
  if (removed.length === 0) {
    return;
  }
  const deletedSpots = loadDeletedSpots();
  const now = formatLocalDateTime(new Date());
  removed.forEach((spot) => {
    deletedSpots[spot.id] = now;
  });
  saveDeletedSpots(deletedSpots);
}

// 保存できたときだけ、画面側のデータも差し替えて表示し直す
function commitSpots(nextSpots) {
  const previous = spots;
  try {
    saveSpots(nextSpots);
    recordDeletedSpots(previous, nextSpots);
  } catch (error) {
    console.error(error);
    alert('保存できませんでした。もう一度お試しください');
    return false;
  }
  spots = nextSpots;
  renderMarkers();
  renderList();
  renderSettings();
  // ログインしていれば、変わった記録をほかの端末へ送る（sync.js）
  window.cloudSync?.pushChanges(previous, nextSpots);
  return true;
}

// ほかの端末で変わった記録を受け取ったとき（sync.js から呼ぶ）。送り返さないよう commitSpots は通さない
function applySyncedSpots(nextSpots) {
  saveSpots(nextSpots);
  spots = nextSpots;
  renderMarkers();
  renderList();
  renderSettings();

  // 開いている画面の記録が、ほかの端末で消されたり変わったりしたとき
  if (detailId !== null) {
    const shown = findSpot(detailId);
    if (shown) {
      renderDetail(shown);
    } else {
      closeDetail();
    }
  }
  if (editingId !== null && !findSpot(editingId)) {
    closeSheet();
    showToast('編集中の記録が、ほかの端末で削除されました');
  }
}

function saveUpdatedSpot(updated) {
  return commitSpots(spots.map((spot) => (spot.id === updated.id ? updated : spot)));
}

// ---- 絞り込み（地図とリストの両方に効く） ----

const filter = { status: 'all', type: 'all', minRating: 0, sauna: false, outlet: false, wifi: false };

function isFiltering() {
  return filter.status !== 'all' || filter.type !== 'all' || filter.minRating > 0
    || filter.sauna || filter.outlet || filter.wifi;
}

function matchesFilter(spot) {
  return (filter.status === 'all' || spot.status === filter.status)
    && (filter.type === 'all' || spot.type === filter.type)
    && (spot.rating ?? 0) >= filter.minRating
    && (!filter.sauna || spot.extra.sauna === true)
    && (!filter.outlet || spot.extra.outlet === true)
    && (!filter.wifi || spot.extra.wifi === true);
}

// ---- 記録のピン ----

const markers = new Map(); // 記録のID → ピン

// 行きたい店は白抜きのピンにして、行った店と見分けられるようにする
function spotIcon(type, status) {
  const color = TYPE_COLORS[type];
  const want = status === 'want';
  return L.divIcon({
    className: 'spot-pin',
    html: `<svg width="28" height="40" viewBox="0 0 28 40" aria-hidden="true">
      <path d="M14 1.5C7.1 1.5 1.5 7.1 1.5 14c0 9.5 12.5 24.5 12.5 24.5S26.5 23.5 26.5 14c0-6.9-5.6-12.5-12.5-12.5Z"
        fill="${want ? '#ffffff' : color}" stroke="${want ? color : '#ffffff'}" stroke-width="${want ? 2.5 : 2}"/>
      <circle cx="14" cy="14" r="5" fill="${want ? color : '#ffffff'}"/>
    </svg>`,
    iconSize: [28, 40],
    iconAnchor: [14, 39],
    popupAnchor: [0, -34],
  });
}

function addSpotMarker(spot) {
  const marker = L.marker([spot.lat, spot.lng], { icon: spotIcon(spot.type, spot.status), title: spot.name })
    .addTo(map)
    .on('click', () => {
      // 位置を直している間は詳細画面を開かない
      if (movingId === null) {
        openDetail(spot.id);
      }
    });
  markers.set(spot.id, marker);
}

// 絞り込みに合う記録だけ、ピンを立て直す
function renderMarkers() {
  markers.forEach((marker) => marker.remove());
  markers.clear();
  spots.filter(matchesFilter).forEach(addSpotMarker);
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

// シートを開いている間は、地図の上のボタンを隠す（style.css の body.has-sheet）
function updateSheetState() {
  const open = document.querySelector('.sheet.is-open') !== null;
  document.body.classList.toggle('has-sheet', open);
}

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

  const shown = spots.filter(matchesFilter);
  // 行った店は訪問日の新しい順（同じ日なら、あとに記録したものを上）、行きたい店は追加した新しい順
  const visited = shown
    .filter((spot) => spot.status === 'visited')
    .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt) || b.createdAt.localeCompare(a.createdAt));
  const want = shown
    .filter((spot) => spot.status === 'want')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  listTitle.textContent = isFiltering()
    ? `記録一覧（${shown.length}件 / 全${spots.length}件）`
    : `記録一覧（${spots.length}件）`;
  listEmpty.hidden = shown.length > 0;
  listEmpty.textContent = spots.length === 0
    ? 'まだ記録がありません。地図の「＋ ここを記録」から記録できます。'
    : '絞り込みに合う記録がありません。';
  spotList.replaceChildren(
    ...[['行った', visited], ['行きたい', want]]
      .filter(([, items]) => items.length > 0)
      .map(([title, items]) => createListSection(`${title}（${items.length}件）`, items)),
  );
}

function createListSection(title, items) {
  const heading = document.createElement('h3');
  heading.className = 'list-section-title';
  heading.textContent = title;

  const list = document.createElement('ul');
  list.className = 'spot-list';
  list.append(...items.map(createListItem));

  const section = document.createElement('section');
  section.append(heading, list);
  return section;
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

  const when = spot.status === 'want'
    ? `${formatDisplayDate(spot.createdAt.slice(0, 10))}に追加`
    : formatDisplayDate(spot.visitedAt);
  const meta = document.createElement('span');
  meta.className = 'spot-row-meta';
  meta.append(type, `・${when}`);

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
const detailStatus = document.getElementById('detail-status');
const detailName = document.getElementById('detail-name');
const detailDateLabel = document.getElementById('detail-date-label');
const detailDate = document.getElementById('detail-date');
const detailRatingRow = document.getElementById('detail-rating-row');
const detailRating = document.getElementById('detail-rating');
const detailExtra = document.getElementById('detail-extra');
const detailComment = document.getElementById('detail-comment');
const detailVisitButton = document.getElementById('detail-visit');

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

// 種類別の追加項目のうち、入力されているものを [見出し, 値] で返す
function extraEntries(spot) {
  const { extra } = spot;
  const yesNo = (value) => (value ? 'あり' : 'なし');
  const entries = [];
  if (spot.type === 'sento') {
    if (typeof extra.sauna === 'boolean') entries.push(['サウナ', yesNo(extra.sauna)]);
    if (Number.isFinite(extra.coldBathTemp)) entries.push(['水風呂', `${extra.coldBathTemp}℃`]);
    if (Number.isFinite(extra.price)) entries.push(['入浴料', `${extra.price.toLocaleString()}円`]);
  } else {
    if (typeof extra.outlet === 'boolean') entries.push(['電源', yesNo(extra.outlet)]);
    if (typeof extra.wifi === 'boolean') entries.push(['Wi-Fi', yesNo(extra.wifi)]);
    if (extra.ordered) entries.push(['頼んだもの', extra.ordered]);
  }
  return entries;
}

function renderDetail(spot) {
  const want = spot.status === 'want';
  detailType.className = `type-badge type-${spot.type}`;
  detailType.textContent = TYPE_LABELS[spot.type];
  detailStatus.hidden = !want;
  // 店名や感想は textContent で入れる（HTMLとして解釈させない）
  detailName.textContent = spot.name;
  detailDateLabel.textContent = want ? '追加日' : '訪問日';
  detailDate.textContent = formatDisplayDate(want ? spot.createdAt.slice(0, 10) : spot.visitedAt);
  detailRatingRow.hidden = want;
  detailRating.className = spot.rating ? 'stars' : 'muted';
  detailRating.textContent = spot.rating ? formatStars(spot.rating) : '未評価';

  const entries = extraEntries(spot);
  detailExtra.hidden = entries.length === 0;
  detailExtra.replaceChildren(...entries.map(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    const row = document.createElement('div');
    row.append(term, description);
    return row;
  }));

  detailComment.classList.toggle('is-empty', spot.comment === '');
  detailComment.textContent = spot.comment || (want ? 'メモはまだありません' : '感想はまだありません');
  detailVisitButton.hidden = !want;
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

  closeDetail();
  showToast(`「${spot.name}」を削除しました`);
}

// 行きたい店に行ったら「行った」に切り替え、評価や写真を書けるように編集を開く
function markVisited(id) {
  const spot = findSpot(id);
  const now = new Date();
  const visited = {
    ...spot,
    status: 'visited',
    visitedAt: formatLocalDate(now),
    updatedAt: formatLocalDateTime(now),
  };
  if (!saveUpdatedSpot(visited)) {
    return;
  }
  renderDetail(visited);
  openSheet(visited);
}

document.getElementById('detail-back').addEventListener('click', closeDetail);
document.getElementById('detail-edit').addEventListener('click', () => openSheet(findSpot(detailId)));
document.getElementById('detail-delete').addEventListener('click', () => deleteSpot(detailId));
document.getElementById('detail-move').addEventListener('click', () => startMove(detailId));
detailVisitButton.addEventListener('click', () => markVisited(detailId));

// ---- ピンの位置を直す ----
// 地図を動かすつもりで誤ってピンを動かさないよう、詳細画面から始めたときだけドラッグできる

const moveBar = document.getElementById('move-bar');
let movingId = null; // 位置を直している記録のID

function startMove(id) {
  // 絞り込みでピンが出ていないときは、一時的に立てる
  if (!markers.has(id)) {
    addSpotMarker(findSpot(id));
  }
  const marker = markers.get(id);
  movingId = id;

  closeDetail();
  showView('map');
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), CURRENT_ZOOM));
  marker.dragging.enable();
  document.body.classList.add('is-moving');
  moveBar.hidden = false;
}

// 終わったら、保存されている位置でピンを立て直す（キャンセルならもとの位置に戻る）
function endMove() {
  markers.get(movingId)?.dragging.disable();
  movingId = null;
  document.body.classList.remove('is-moving');
  moveBar.hidden = true;
  renderMarkers();
}

document.getElementById('move-cancel').addEventListener('click', endMove);

document.getElementById('move-done').addEventListener('click', () => {
  const { lat, lng } = markers.get(movingId).getLatLng();
  const spot = findSpot(movingId);
  if (!saveUpdatedSpot({ ...spot, lat, lng, updatedAt: formatLocalDateTime(new Date()) })) {
    return;
  }
  endMove();
  showToast(`「${spot.name}」の位置を直しました`);
});

// ---- 記録シート（新規記録・行きたい店の追加・編集で共用） ----

const recordButton = document.getElementById('record-button');
const sheet = document.getElementById('record-sheet');
const sheetTitle = document.getElementById('sheet-title');
const nameInput = document.getElementById('name-input');
const visitedField = document.getElementById('visited-field');
const visitedInput = document.getElementById('visited-input');
const ratingField = document.getElementById('rating-field');
const ratingButtons = sheet.querySelectorAll('.rating button');
const commentLabel = document.getElementById('comment-label');
const commentInput = document.getElementById('comment-input');
const photoThumbs = document.getElementById('photo-thumbs');
const cameraButton = document.getElementById('camera-button');
const albumButton = document.getElementById('album-button');
const cameraInput = document.getElementById('camera-input');
const albumInput = document.getElementById('album-input');
const extraFields = document.getElementById('extra-fields');
const extraGroups = {
  sento: document.getElementById('extra-sento'),
  cafe: document.getElementById('extra-cafe'),
};
const extraSauna = document.getElementById('extra-sauna');
const extraColdBath = document.getElementById('extra-cold-bath');
const extraPrice = document.getElementById('extra-price');
const extraOutlet = document.getElementById('extra-outlet');
const extraWifi = document.getElementById('extra-wifi');
const extraOrdered = document.getElementById('extra-ordered');
const saveButton = document.getElementById('save-button');

let editingId = null; // 編集中の記録のID（新規のときは null）
let draftStatus = 'visited'; // 新規のときの状態（行った / 行きたい）
let draftLatLng = null; // 新規の位置（「＋ ここを記録」を押した時点か、長押しした場所）
let draftUsesMapCenter = false;
let draftRating = null;
let draftPhotos = []; // シートに付けている写真 { id, blob, url, isNew }
let removedPhotoIds = []; // 編集で外した、保存済みの写真のID
let pendingPhotos = 0; // 読み込み中・縮小中の写真の枚数（この間は保存できない）
let sheetSession = 0; // シートを開くたびに増やす（閉じたあとに届いた写真を捨てるため）
let saving = false;
let draftMarker = null; // 行きたい店を追加するときに、長押しした場所に出す仮のピン

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

function currentType() {
  return sheet.querySelector('input[name="type"]:checked').value;
}

// 種類は前回選んだものを初期値にする
function lastTypeOrDefault() {
  const lastType = loadLastType();
  return Object.keys(TYPE_LABELS).includes(lastType) ? lastType : 'sento';
}

// 選んでいる種類の追加項目だけを出す（隠した欄は入力チェックの対象から外す）
function updateExtraVisibility() {
  const type = currentType();
  Object.entries(extraGroups).forEach(([groupType, group]) => {
    const hidden = extraFields.hidden || groupType !== type;
    group.hidden = hidden;
    group.querySelectorAll('input, select').forEach((control) => {
      control.disabled = hidden;
    });
  });
}

function fillExtra(extra) {
  const choice = (value) => {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return '';
  };
  extraSauna.value = choice(extra.sauna);
  extraColdBath.value = extra.coldBathTemp ?? '';
  extraPrice.value = extra.price ?? '';
  extraOutlet.value = choice(extra.outlet);
  extraWifi.value = choice(extra.wifi);
  extraOrdered.value = extra.ordered ?? '';
}

// 入力されていない項目は null（頼んだものは空文字）にする
function readExtra(type) {
  const yesNo = (select) => (select.value === '' ? null : select.value === 'yes');
  const number = (input) => (input.value === '' ? null : Number(input.value));
  if (type === 'sento') {
    return { sauna: yesNo(extraSauna), coldBathTemp: number(extraColdBath), price: number(extraPrice) };
  }
  return { outlet: yesNo(extraOutlet), wifi: yesNo(extraWifi), ordered: extraOrdered.value.trim() };
}

function showDraftMarker(latlng) {
  removeDraftMarker();
  draftMarker = L.marker(latlng, { icon: spotIcon(currentType(), 'want'), interactive: false, keyboard: false })
    .addTo(map);
}

function removeDraftMarker() {
  draftMarker?.remove();
  draftMarker = null;
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

// spot を渡すと編集、渡さないと新規。新規で status: 'want' なら、latlng の場所を行きたいリストに追加する
function openSheet(spot = null, { status = 'visited', latlng = null } = {}) {
  // 起動時のお知らせなどがシートの入力欄に重ならないよう消しておく
  hideToast();
  sheet.reset();
  sheetSession += 1;
  clearDraftPhotos();
  removeDraftMarker();
  saving = false;
  editingId = spot ? spot.id : null;
  draftStatus = spot ? spot.status : status;
  const want = draftStatus === 'want';

  if (spot) {
    sheetTitle.textContent = '記録を編集';
  } else {
    sheetTitle.textContent = want ? '行きたい店を追加' : '記録する';
  }
  commentLabel.textContent = want ? 'メモ' : 'ひとこと感想';
  // 訪問日と追加項目は編集のときだけ、評価は行った店のときだけ出す
  visitedField.hidden = !spot || want;
  ratingField.hidden = want;
  extraFields.hidden = !spot;

  if (spot) {
    setType(spot.type);
    nameInput.value = spot.name;
    visitedInput.value = spot.visitedAt ?? '';
    setRating(spot.rating);
    commentInput.value = spot.comment;
    fillExtra(spot.extra);
  } else {
    setType(lastTypeOrDefault());
    setRating(null);
    if (want) {
      draftLatLng = latlng;
      draftUsesMapCenter = false;
      showDraftMarker(latlng);
      // シートに隠れないよう、長押しした場所が画面の上のほうに来るように地図を動かす
      const point = map.latLngToContainerPoint(latlng);
      map.panBy([0, point.y - map.getSize().y * 0.2]);
    } else {
      // 押した時点の最新の現在地を使う。取れていなければ地図の中心で記録し、あとでピンを動かして直す
      draftUsesMapCenter = lastPosition === null;
      if (draftUsesMapCenter) {
        const center = map.getCenter();
        draftLatLng = [center.lat, center.lng];
      } else {
        draftLatLng = lastPosition;
      }
    }
  }
  updateExtraVisibility();

  renderDraftPhotos();
  if (spot) {
    loadDraftPhotos(spot.photoIds);
  }

  sheet.classList.add('is-open');
  updateSheetState();
  // 新規のときは、すぐに店名を打てるようにする
  if (!spot) {
    nameInput.focus({ preventScroll: true });
  }
}

function closeSheet() {
  sheet.classList.remove('is-open');
  updateSheetState();
  sheetSession += 1; // 縮小中・読み込み中の写真は捨てる
  clearDraftPhotos();
  removeDraftMarker();
  // 入力中ならキーボードを閉じる
  if (sheet.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}

recordButton.addEventListener('click', () => openSheet());
document.getElementById('sheet-close').addEventListener('click', closeSheet);

// 地図を長押し（PCでは右クリック）すると、その場所を行きたいリストに追加できる
map.on('contextmenu', (event) => {
  if (movingId !== null || document.body.classList.contains('has-sheet')) {
    return;
  }
  openSheet(null, { status: 'want', latlng: [event.latlng.lat, event.latlng.lng] });
});

sheet.querySelectorAll('input[name="type"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    updateExtraVisibility();
    draftMarker?.setIcon(spotIcon(currentType(), 'want'));
  });
});

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
  const type = currentType();
  const draft = {
    status: draftStatus,
    type,
    name,
    comment: commentInput.value.trim(),
    rating: draftRating,
    visitedAt: visitedInput.value,
    extra: editingId === null ? {} : readExtra(type),
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

  const want = draft.status === 'want';
  const spot = {
    id,
    status: draft.status,
    type: draft.type,
    name: draft.name,
    lat: draft.latlng[0],
    lng: draft.latlng[1],
    // 行きたい店はまだ行っていないので、訪問日も評価もない
    visitedAt: want ? null : formatLocalDate(now),
    rating: want ? null : draft.rating,
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

  closeSheet();
  if (!map.getBounds().contains(draft.latlng)) {
    map.panTo(draft.latlng);
  }

  let message = `「${draft.name}」を記録しました`;
  if (want) {
    message = `「${draft.name}」を行きたいリストに追加しました`;
  } else if (draft.usesMapCenter) {
    message = `現在地が取れないため、地図の中心に「${draft.name}」を記録しました`;
  }
  if (!matchesFilter(spot)) {
    message += '（絞り込み中のため表示されていません）';
  }
  showToast(message);
}

async function updateSpot(id, draft) {
  const newPhotoIds = await saveNewPhotos(id, draft.photos);
  if (newPhotoIds === null) {
    return;
  }

  const spot = findSpot(id);
  const want = spot.status === 'want';
  const updated = {
    ...spot,
    type: draft.type,
    name: draft.name,
    // 訪問日が空にされたときは元の日付のままにする
    visitedAt: want ? null : (draft.visitedAt || spot.visitedAt),
    rating: want ? null : draft.rating,
    comment: draft.comment,
    photoIds: draft.photos.map((photo) => photo.id),
    extra: draft.extra,
    updatedAt: formatLocalDateTime(new Date()),
  };
  if (!saveUpdatedSpot(updated)) {
    deletePhotos(newPhotoIds).catch((error) => console.error(error));
    return;
  }
  // 外した写真は、記録を保存できてから消す
  deletePhotos(draft.removedPhotoIds).catch((error) => console.error(error));

  if (detailId === id) {
    renderDetail(updated);
  }
  closeSheet();
  showToast('保存しました');
}

// ---- 絞り込みの画面 ----

const filterSheet = document.getElementById('filter-sheet');
const filterCount = document.getElementById('filter-count');
const filterButtons = document.querySelectorAll('.filter-button');

function updateFilterIndicators() {
  const active = isFiltering();
  filterButtons.forEach((button) => button.classList.toggle('is-active', active));
  filterCount.textContent = `${spots.filter(matchesFilter).length}件 / 全${spots.length}件を表示しています`;
}

// フォームの選択を読み取って、地図とリストに反映する
function applyFilterForm() {
  const data = new FormData(filterSheet);
  filter.status = data.get('status');
  filter.type = data.get('type');
  filter.minRating = Number(data.get('rating'));
  filter.sauna = data.has('sauna');
  filter.outlet = data.has('outlet');
  filter.wifi = data.has('wifi');
  renderMarkers();
  renderList();
  updateFilterIndicators();
}

function openFilter() {
  if (sheet.classList.contains('is-open')) {
    return;
  }
  updateFilterIndicators();
  filterSheet.classList.add('is-open');
  updateSheetState();
}

function closeFilter() {
  filterSheet.classList.remove('is-open');
  updateSheetState();
}

filterButtons.forEach((button) => button.addEventListener('click', openFilter));
filterSheet.addEventListener('change', applyFilterForm);
document.getElementById('filter-close').addEventListener('click', closeFilter);
document.getElementById('filter-done').addEventListener('click', closeFilter);
document.getElementById('filter-reset').addEventListener('click', () => {
  filterSheet.reset();
  applyFilterForm();
});
filterSheet.addEventListener('submit', (event) => event.preventDefault());

// ---- 設定画面（統計・バックアップ） ----

const settingsTab = document.querySelector('.tab[data-view="settings"]');
const statVisited = document.getElementById('stat-visited');
const statWant = document.getElementById('stat-want');
const statPhotos = document.getElementById('stat-photos');
const monthlyStats = document.getElementById('monthly-stats');
const monthlyEmpty = document.getElementById('monthly-empty');
const lastBackupEl = document.getElementById('last-backup');
const backupWarning = document.getElementById('backup-warning');
const exportButton = document.getElementById('export-button');
const importInput = document.getElementById('import-input');
const importDialog = document.getElementById('import-dialog');
const importSummary = document.getElementById('import-summary');
let pendingBackup = null; // 読み込んだあと、追加か上書きかを選んでもらっているバックアップ

function countByType(list, type) {
  return list.filter((spot) => spot.type === type).length;
}

function createMonthRow({ key, sento, cafe }, max) {
  const [year, month] = key.split('-').map(Number);
  const label = document.createElement('span');
  label.className = 'month-label';
  label.textContent = `${year}年${month}月`;

  const bar = document.createElement('span');
  bar.className = 'month-bar';
  [['sento', sento], ['cafe', cafe]].forEach(([type, count]) => {
    if (count > 0) {
      const segment = document.createElement('span');
      segment.className = `month-bar-${type}`;
      segment.style.width = `${(count / max) * 100}%`;
      bar.append(segment);
    }
  });

  const total = document.createElement('span');
  total.className = 'month-total';
  total.textContent = String(sento + cafe);

  // 棒の内訳は読み上げ用に文字でも入れておく
  const breakdown = document.createElement('span');
  breakdown.className = 'visually-hidden';
  breakdown.textContent = `銭湯${sento}件、カフェ${cafe}件`;

  const item = document.createElement('li');
  item.append(label, bar, total, breakdown);
  return item;
}

function renderStats() {
  const visited = spots.filter((spot) => spot.status === 'visited');
  const want = spots.filter((spot) => spot.status === 'want');
  const photoCount = spots.reduce((sum, spot) => sum + spot.photoIds.length, 0);
  statVisited.textContent = `${visited.length}件（銭湯 ${countByType(visited, 'sento')}・カフェ ${countByType(visited, 'cafe')}）`;
  statWant.textContent = `${want.length}件`;
  statPhotos.textContent = `${photoCount}枚`;

  monthlyEmpty.hidden = visited.length > 0;
  if (visited.length === 0) {
    monthlyStats.replaceChildren();
    return;
  }

  // 今月から最大12か月さかのぼる（最初に訪問した月より前は出さない）
  const firstMonth = visited.map((spot) => spot.visitedAt.slice(0, 7)).sort()[0];
  const cursor = new Date();
  cursor.setDate(1);
  const months = [];
  for (let i = 0; i < STATS_MONTHS; i += 1) {
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`;
    if (key < firstMonth) {
      break;
    }
    const inMonth = visited.filter((spot) => spot.visitedAt.startsWith(key));
    months.push({ key, sento: countByType(inMonth, 'sento'), cafe: countByType(inMonth, 'cafe') });
    cursor.setMonth(cursor.getMonth() - 1);
  }
  const max = Math.max(1, ...months.map((month) => month.sento + month.cafe));
  monthlyStats.replaceChildren(...months.map((month) => createMonthRow(month, max)));
}

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
  renderStats();
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

// ---- ホーム画面に追加したとき（PWA） ----

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// ホーム画面から開いているときは、追加のしかたの案内を出さない
document.getElementById('install-section').hidden = isStandalone;

// 電波の弱い場所でも開けるよう、画面のファイルを Service Worker でキャッシュする
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((error) => console.error(error));
}

// ホーム画面から開いたときは、保存したデータを消さないようブラウザに頼む
if (isStandalone && navigator.storage?.persist) {
  navigator.storage.persist().catch((error) => console.error(error));
}

// Esc キーで、いちばん上に開いている画面を閉じる（PCで使うとき用）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (sheet.classList.contains('is-open')) {
    closeSheet();
  } else if (filterSheet.classList.contains('is-open')) {
    closeFilter();
  } else if (!detailView.hidden) {
    closeDetail();
  }
});

// ---- 起動時 ----

renderMarkers();
renderList();
renderSettings();
updateFilterIndicators();
if (isBackupOverdue()) {
  showToast(`最後のバックアップから${BACKUP_REMIND_DAYS}日以上たっています。設定から書き出してください`, 6000);
}
