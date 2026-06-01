// minotel 提供先管理ツール - メインロジック
import { firebaseConfig, APP_PASSWORD } from "./firebase-config.js";
import { SEED } from "./seed-data.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, deleteDoc,
  onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ====== 要素参照 ======
const $ = (id) => document.getElementById(id);
const gateEl = $("gate"), setupEl = $("setup"), appEl = $("app");

// ====== 状態 ======
const state = {
  items: [],
  search: "",
  statusFilter: new Set(),
  colorFilter: new Set(),
  ratioMax: null,
  sort: "followers_desc",
  editingId: null,   // 編集中のドキュメントID（新規はnull）
  draftPhotos: [],   // モーダル内の写真（base64）
  lightbox: { photos: [], index: 0 }, // 拡大表示の状態
};

let db = null;

// ====== 進捗タグ定義（カード上でON/OFF・複数同時可） ======
const PROGRESS_TAGS = [
  { key: "発送済",         label: "発送",       icon: "📦", color: "#5aa6d8" },
  { key: "プロモ画像作成済", label: "プロモ画像", icon: "🖼️", color: "#a570d8" },
  { key: "プロモ詳細送信済", label: "プロモ詳細", icon: "📨", color: "#d88a3c" },
  { key: "PR完了",         label: "PR",         icon: "📢", color: "#3aab66" },
];

// ====== ユーティリティ ======
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || "")) ? u : "";
}
function parseXId(link) {
  const m = String(link || "").match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]+)/i);
  return m ? m[1] : "";
}

// URLからSNS名を自動判別（不明な場合はホスト名から推測）
const SNS_RULES = [
  [/youtube\.com|youtu\.be/i, "YouTube"],
  [/(?:^|\W)x\.com|twitter\.com/i, "X"],
  [/instagram\.com/i, "Instagram"],
  [/tiktok\.com/i, "TikTok"],
  [/twitch\.tv/i, "Twitch"],
  [/bilibili\.com/i, "Bilibili"],
  [/(?:niconico|nicovideo)\.jp/i, "ニコニコ"],
  [/bsky\.app/i, "Bluesky"],
  [/threads\.(?:net|com)/i, "Threads"],
  [/facebook\.com|fb\.com/i, "Facebook"],
  [/discord\.(?:com|gg)/i, "Discord"],
  [/linkedin\.com/i, "LinkedIn"],
  [/note\.com/i, "note"],
  [/pixiv\.net/i, "pixiv"],
  [/booth\.pm/i, "BOOTH"],
  [/skeb\.jp/i, "Skeb"],
  [/twitcasting\.tv/i, "ツイキャス"],
  [/showroom-live\.com/i, "SHOWROOM"],
  [/mildom\.com/i, "Mildom"],
  [/mirrativ\.com/i, "Mirrativ"],
  [/reality\.app/i, "REALITY"],
  [/spoon\.cr/i, "Spoon"],
  [/17\.live/i, "17LIVE"],
  [/vrchat\.com/i, "VRChat"],
  [/soundcloud\.com/i, "SoundCloud"],
  [/spotify\.com/i, "Spotify"],
  [/patreon\.com/i, "Patreon"],
  [/fanbox\.cc/i, "FANBOX"],
  [/ci-en\.(?:jp|net)/i, "Ci-en"],
  [/linktr\.ee/i, "Linktree"],
  [/lit\.link/i, "lit.link"],
  [/github\.com/i, "GitHub"],
  [/zenn\.dev/i, "Zenn"],
  [/qiita\.com/i, "Qiita"],
  [/tumblr\.com/i, "Tumblr"],
  [/reddit\.com/i, "Reddit"],
];
function detectSnsName(url) {
  const s = String(url || "");
  for (const [re, name] of SNS_RULES) if (re.test(s)) return name;
  // フォールバック: ホストの第二レベルドメインから推測
  try {
    const host = new URL(s).hostname.replace(/^www\./, "");
    const base = host.split(".").slice(-2)[0];
    if (base && !/^(com|co|net|org|jp|tv|app|live|cr|gg|pm)$/.test(base) && base.length >= 2) {
      return base.charAt(0).toUpperCase() + base.slice(1);
    }
  } catch (_) {}
  return "";
}
function fmtNum(n) {
  return (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ja-JP");
}
// フォロー率 = フォロー数 ÷ フォロワー数（％）。低いほど影響力が高い目安。
function calcRatio(item) {
  const fr = Number(item.followers), fg = Number(item.following);
  if (!fr || fr <= 0 || item.following === null || item.following === undefined || item.following === "") return null;
  return (fg / fr) * 100;
}
function ratioClass(r) {
  if (r === null) return "ratio-na";
  if (r < 30) return "ratio-low";
  if (r < 80) return "ratio-mid";
  return "ratio-high";
}
function ratioText(r) {
  if (r === null) return "フォロー率 —";
  const v = r < 10 ? r.toFixed(1) : Math.round(r);
  return `フォロー率 ${v}%`;
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2200);
}

// ====== 起動 ======
function isConfigured() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE_");
}

function boot() {
  if (!isConfigured()) {
    gateEl.hidden = true;
    setupEl.hidden = false;
    return;
  }
  // パスワード確認済みならそのままアプリへ
  if (sessionStorage.getItem("mn_auth") === "1") {
    openApp();
  } else {
    setupGate();
  }
}

function setupGate() {
  const input = $("gate-input"), btn = $("gate-btn"), err = $("gate-err");
  const tryAuth = () => {
    if (input.value === APP_PASSWORD) {
      sessionStorage.setItem("mn_auth", "1");
      openApp();
    } else {
      err.hidden = false;
      input.value = "";
      input.focus();
    }
  };
  btn.addEventListener("click", tryAuth);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryAuth(); });
  input.focus();
}

async function openApp() {
  gateEl.hidden = true;
  appEl.hidden = false;
  bindUI();
  try {
    const fbApp = initializeApp(firebaseConfig);
    db = getFirestore(fbApp);
  } catch (e) {
    console.error(e);
    toast("接続エラー: " + (e.message || e));
  }
  await seedIfNeeded();
  subscribe();
}

// ====== 初期データ投入（1回だけ） ======
async function seedIfNeeded() {
  try {
    const marker = await getDoc(doc(db, "_meta", "seed"));
    if (marker.exists()) return;
    const batch = writeBatch(db);
    SEED.forEach((s, i) => {
      const { id, ...rest } = s;
      batch.set(doc(db, "influencers", id), {
        ...rest,
        order: i,
        createdAt: Date.now(),
      });
    });
    batch.set(doc(db, "_meta", "seed"), { done: true, at: serverTimestamp() });
    await batch.commit();
    toast("初期データ " + SEED.length + "件を登録しました");
  } catch (e) {
    console.error("seed error", e);
  }
}

// ====== リアルタイム購読 ======
function subscribe() {
  onSnapshot(collection(db, "influencers"), (snap) => {
    state.items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => {
    console.error(err);
    toast("読み込みエラー: ルール設定を確認してください");
  });
}

// ====== 絞り込み・並べ替え ======
function visibleItems() {
  let arr = state.items.slice();
  const q = state.search.trim().toLowerCase();
  if (q) {
    arr = arr.filter((it) =>
      String(it.name || "").toLowerCase().includes(q) ||
      String(it.xId || "").toLowerCase().includes(q)
    );
  }
  if (state.statusFilter.size) arr = arr.filter((it) => state.statusFilter.has(it.status));
  if (state.colorFilter.size) arr = arr.filter((it) => state.colorFilter.has(it.color));
  if (state.ratioMax !== null) {
    arr = arr.filter((it) => {
      const r = calcRatio(it);
      return r !== null && r <= state.ratioMax;
    });
  }
  const s = state.sort;
  arr.sort((a, b) => {
    const fa = Number(a.followers) || 0, fb = Number(b.followers) || 0;
    const ra = calcRatio(a), rb = calcRatio(b);
    switch (s) {
      case "followers_asc": return fa - fb;
      case "followers_desc": return fb - fa;
      case "ratio_asc": return (ra ?? Infinity) - (rb ?? Infinity);
      case "ratio_desc": return (rb ?? -1) - (ra ?? -1);
      case "name_asc": return String(a.name).localeCompare(String(b.name), "ja");
      case "created_desc": return (b.createdAt || 0) - (a.createdAt || 0);
      default: return 0;
    }
  });
  return arr;
}

// ====== 描画 ======
function render() {
  const list = $("list"), empty = $("empty");
  const items = visibleItems();
  $("count-text").textContent = items.length + "件 / 全" + state.items.length + "件";
  list.innerHTML = "";
  empty.hidden = items.length > 0;

  for (const it of items) {
    const r = calcRatio(it);
    const card = document.createElement("div");
    card.className = "card";
    card.addEventListener("click", () => openModal(it.id));

    const xUrl = safeUrl(it.xLink) || (it.xId ? `https://x.com/${esc(it.xId)}` : "");
    const idLine = it.xId
      ? `<a class="card-id" href="${esc(xUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">@${esc(it.xId)}</a>`
      : `<span class="card-id">@—</span>`;

    const badges = [];
    if (it.status) badges.push(`<span class="badge badge-status-${esc(it.status)}">${esc(it.status)}</span>`);
    if (it.color) badges.push(`<span class="badge badge-color-${esc(it.color)}">${esc(it.color)}</span>`);

    const photos = (it.photos || []);
    const photosHtml = photos.length
      ? `<div class="card-photos">${photos.map((src, i) => `<img class="card-photo" data-i="${i}" src="${esc(src)}" alt="">`).join("")}</div>`
      : `<div class="card-nophoto">📷 写真なし（カードを開いて追加）</div>`;

    const noteHtml = (it.note && it.note.trim())
      ? `<div class="card-note">${esc(it.note)}</div>`
      : "";

    const progSet = new Set(it.progress || []);
    const progressHtml = `<div class="progress-chips">${
      PROGRESS_TAGS.map(t => {
        const on = progSet.has(t.key);
        const style = on ? `background:${t.color};border-color:${t.color}` : "";
        return `<button type="button" class="progress-chip${on ? " on" : ""}" data-tag="${esc(t.key)}" style="${style}" title="${esc(t.key)}">${t.icon} ${esc(t.label)}</button>`;
      }).join("")
    }</div>`;

    const extra = [];
    (it.otherSns || []).forEach((s) => {
      const u = safeUrl(s.url);
      if (u) extra.push(`<a class="tag-link" href="${esc(u)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(s.label || "SNS")}</a>`);
    });
    (it.prPosts || []).forEach((p) => {
      const u = safeUrl(p.url);
      if (u) extra.push(`<a class="tag-link" href="${esc(u)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">PR: ${esc(p.label || "投稿")}</a>`);
    });

    card.innerHTML = `
      <div class="card-head">
        <div class="card-name">${esc(it.name || "（名前なし）")}</div>
        ${idLine}
        <div class="badges">${badges.join("")}</div>
      </div>
      <div class="stats">
        <span class="stat">フォロワー<b>${fmtNum(it.followers)}</b></span>
        <span class="stat">フォロー<b>${fmtNum(it.following)}</b></span>
        <span class="ratio-badge ${ratioClass(r)}">${ratioText(r)}</span>
      </div>
      ${progressHtml}
      ${photosHtml}
      ${noteHtml}
      ${extra.length ? `<div class="card-extra">${extra.join("")}</div>` : ""}
    `;
    // 写真クリックで拡大（カードの編集は開かない）
    card.querySelectorAll(".card-photo").forEach((img) => {
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox(photos, Number(img.dataset.i) || 0);
      });
    });
    // 進捗チップでON/OFF切替（カード詳細は開かない）
    card.querySelectorAll(".progress-chip").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleProgress(it.id, btn.dataset.tag);
      });
    });
    list.appendChild(card);
  }
}

// ====== 進捗タグの切替（カードから直接） ======
async function toggleProgress(id, tag) {
  if (!db) return;
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const cur = new Set(it.progress || []);
  cur.has(tag) ? cur.delete(tag) : cur.add(tag);
  const arr = [...cur];
  it.progress = arr; // 即時反映（楽観更新）
  render();
  try {
    await setDoc(doc(db, "influencers", id), { progress: arr }, { merge: true });
  } catch (e) {
    console.error(e);
    toast("更新エラー: " + (e.message || e));
  }
}

// ====== モーダル ======
function openModal(id) {
  state.editingId = id;
  const it = id ? state.items.find((x) => x.id === id) : null;
  $("modal-title").textContent = it ? "編集" : "新規追加";
  $("modal-delete").hidden = !it;

  $("f-xlink").value = it?.xLink || "";
  $("f-name").value = it?.name || "";
  $("f-xid").value = it?.xId || "";
  $("f-followers").value = (it?.followers ?? "");
  $("f-following").value = (it?.following ?? "");
  $("f-status").value = it?.status || "検討中";
  $("f-color").value = it?.color || "";
  $("f-note").value = it?.note || "";

  state.draftPhotos = (it?.photos || []).slice();
  renderDraftPhotos();
  renderModalProgress(it?.progress || []);
  renderSubList("sns", it?.otherSns || []);
  renderSubList("pr", it?.prPosts || []);
  updateRatioPreview();

  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("modal").hidden = true;
  document.body.style.overflow = "";
  state.editingId = null;
  state.draftPhotos = [];
}

function renderModalProgress(progress) {
  const cur = new Set(progress || []);
  $("f-progress").innerHTML = PROGRESS_TAGS.map(t => `
    <label class="progress-check${cur.has(t.key) ? " on" : ""}" style="${cur.has(t.key) ? `background:${t.color};border-color:${t.color};color:#fff` : ""}">
      <input type="checkbox" value="${esc(t.key)}" ${cur.has(t.key) ? "checked" : ""}>
      <span>${t.icon} ${esc(t.label)}</span>
    </label>
  `).join("");
  // チェック変更で見た目を更新
  $("f-progress").querySelectorAll("input").forEach((cb) => {
    cb.addEventListener("change", () => {
      const lbl = cb.closest(".progress-check");
      const t = PROGRESS_TAGS.find(x => x.key === cb.value);
      if (cb.checked) { lbl.classList.add("on"); lbl.style.cssText = `background:${t.color};border-color:${t.color};color:#fff`; }
      else { lbl.classList.remove("on"); lbl.style.cssText = ""; }
    });
  });
}
function collectModalProgress() {
  return [...$("f-progress").querySelectorAll("input:checked")].map(i => i.value);
}

function renderDraftPhotos() {
  const grid = $("photo-grid");
  grid.innerHTML = "";
  state.draftPhotos.forEach((src, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";
    div.innerHTML = `<img src="${esc(src)}" alt=""><button type="button" class="photo-del">×</button>`;
    div.querySelector("img").addEventListener("click", () => openLightbox(state.draftPhotos, i));
    div.querySelector(".photo-del").addEventListener("click", () => {
      state.draftPhotos.splice(i, 1);
      renderDraftPhotos();
    });
    grid.appendChild(div);
  });
}

function renderSubList(kind, rows) {
  const wrap = $(kind === "sns" ? "sns-list" : "pr-list");
  wrap.innerHTML = "";
  const labelPh = kind === "sns" ? "種類（例: Instagram）" : "ラベル（例: PR投稿）";
  rows.forEach((row) => addSubRow(wrap, labelPh, row.label, row.url));
}
function addSubRow(wrap, labelPh, label = "", url = "") {
  const div = document.createElement("div");
  div.className = "sub-row";
  div.innerHTML = `
    <input type="text" class="sub-label" placeholder="${labelPh}" value="${esc(label)}" style="flex:0 0 38%">
    <input type="url" class="sub-url" placeholder="https://..." value="${esc(url)}">
    <button type="button" class="sub-del">×</button>`;
  const labelInput = div.querySelector(".sub-label");
  const urlInput = div.querySelector(".sub-url");
  // 手入力されたラベルは尊重（自動更新しない）
  labelInput.addEventListener("input", () => { labelInput.dataset.auto = ""; });
  // URL変更で SNS名を自動検出してラベルを埋める（空 or 自動入力済みの時のみ）
  const tryAuto = () => {
    if (labelInput.value && labelInput.dataset.auto !== "1") return;
    const detected = detectSnsName(urlInput.value);
    if (detected) { labelInput.value = detected; labelInput.dataset.auto = "1"; }
  };
  urlInput.addEventListener("input", tryAuto);
  div.querySelector(".sub-del").addEventListener("click", () => div.remove());
  wrap.appendChild(div);
}
function collectSubList(kind) {
  const wrap = $(kind === "sns" ? "sns-list" : "pr-list");
  return [...wrap.querySelectorAll(".sub-row")].map((r) => ({
    label: r.querySelector(".sub-label").value.trim(),
    url: r.querySelector(".sub-url").value.trim(),
  })).filter((x) => x.url || x.label);
}

function updateRatioPreview() {
  const fr = Number($("f-followers").value), fg = Number($("f-following").value);
  const box = $("ratio-preview");
  if (fr > 0 && $("f-following").value !== "") {
    const r = (fg / fr) * 100;
    const v = r < 10 ? r.toFixed(1) : Math.round(r);
    box.hidden = false;
    box.textContent = `フォロー率: ${v}%（フォロー ${fmtNum(fg)} ÷ フォロワー ${fmtNum(fr)}）　低いほど影響力が高い目安`;
  } else {
    box.hidden = true;
  }
}

// ====== 写真の圧縮（容量節約） ======
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1280;
        let { width, height } = img;
        if (width > max || height > max) {
          const ratio = Math.min(max / width, max / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ====== 保存・削除 ======
async function saveItem() {
  if (!db) { toast("接続待ちです"); return; }
  const data = {
    xLink: $("f-xlink").value.trim(),
    name: $("f-name").value.trim(),
    xId: $("f-xid").value.trim().replace(/^@/, ""),
    followers: $("f-followers").value === "" ? null : Number($("f-followers").value),
    following: $("f-following").value === "" ? null : Number($("f-following").value),
    status: $("f-status").value,
    color: $("f-color").value,
    note: $("f-note").value.trim(),
    otherSns: collectSubList("sns"),
    prPosts: collectSubList("pr"),
    photos: state.draftPhotos,
    progress: collectModalProgress(),
  };
  if (!data.name && !data.xId) { toast("ユーザー名かX IDを入力してください"); return; }

  // ドキュメント容量ガード（Firestoreは1ドキュメント約1MBまで）
  const size = new Blob([JSON.stringify(data)]).size;
  if (size > 900000) {
    toast("写真が多すぎます。枚数を減らしてください");
    return;
  }

  try {
    if (state.editingId) {
      await setDoc(doc(db, "influencers", state.editingId), data, { merge: true });
    } else {
      const id = "id_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      await setDoc(doc(db, "influencers", id), { ...data, order: Date.now(), createdAt: Date.now() });
    }
    closeModal();
    toast("保存しました");
  } catch (e) {
    console.error(e);
    toast("保存エラー: " + (e.message || e));
  }
}

async function deleteItem() {
  if (!state.editingId) return;
  const it = state.items.find((x) => x.id === state.editingId);
  if (!confirm(`「${it?.name || "この提供先"}」を削除しますか？`)) return;
  try {
    await deleteDoc(doc(db, "influencers", state.editingId));
    closeModal();
    toast("削除しました");
  } catch (e) {
    console.error(e);
    toast("削除エラー: " + (e.message || e));
  }
}

// ====== ライトボックス（写真拡大・前後めくり） ======
function openLightbox(photos, index = 0) {
  state.lightbox = { photos: (photos || []).slice(), index };
  renderLightbox();
  $("lightbox").hidden = false;
}
function renderLightbox() {
  const { photos, index } = state.lightbox;
  if (!photos.length) { $("lightbox").hidden = true; return; }
  $("lightbox-img").src = photos[index];
  const multi = photos.length > 1;
  $("lightbox-prev").hidden = !multi;
  $("lightbox-next").hidden = !multi;
  $("lightbox-counter").textContent = multi ? `${index + 1} / ${photos.length}` : "";
}
function lightboxStep(delta) {
  const { photos, index } = state.lightbox;
  if (photos.length < 2) return;
  state.lightbox.index = (index + delta + photos.length) % photos.length;
  renderLightbox();
}
function closeLightbox() { $("lightbox").hidden = true; }

// ====== バックアップ書き出し／読み込み ======
function exportJson() {
  const blob = new Blob([JSON.stringify(state.items, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `minotel提供先_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function importJson(file) {
  try {
    const text = await file.text();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("形式が不正です");
    if (!confirm(`${arr.length}件を読み込みます。同じIDは上書きされます。よろしいですか？`)) return;
    const batch = writeBatch(db);
    arr.forEach((it) => {
      const { id, ...rest } = it;
      const docId = id || ("id_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
      batch.set(doc(db, "influencers", docId), rest, { merge: true });
    });
    await batch.commit();
    toast("読み込みました");
  } catch (e) {
    console.error(e);
    toast("読み込みエラー: " + (e.message || e));
  }
}

// ====== UIイベント結線 ======
function bindUI() {
  // ヘッダー
  $("btn-add").addEventListener("click", () => openModal(null));
  $("btn-menu").addEventListener("click", () => { $("menu").hidden = !$("menu").hidden; });
  document.addEventListener("click", (e) => {
    if (!$("menu").contains(e.target) && e.target !== $("btn-menu")) $("menu").hidden = true;
  });
  $("btn-export").addEventListener("click", () => { exportJson(); $("menu").hidden = true; });
  $("btn-import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
    $("menu").hidden = true;
  });
  $("btn-logout").addEventListener("click", () => {
    sessionStorage.removeItem("mn_auth");
    location.reload();
  });

  // リロード時にブラウザが前回入力を復元するのを防ぐ（検索・フォロー率を空に）
  const resetInputs = () => {
    $("search").value = ""; state.search = ""; $("search-clear").hidden = true;
    $("ratio-max").value = ""; state.ratioMax = null;
  };
  resetInputs();
  // ブラウザの戻る/進む(bfcache)復元時にもリセット
  window.addEventListener("pageshow", (e) => { if (e.persisted) { resetInputs(); render(); } });

  // 検索
  const search = $("search");
  search.addEventListener("input", () => {
    state.search = search.value;
    $("search-clear").hidden = !search.value;
    render();
  });
  $("search-clear").addEventListener("click", () => {
    search.value = ""; state.search = ""; $("search-clear").hidden = true; render();
  });

  // 状況フィルター
  document.querySelectorAll(".chip-status").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.status;
      b.classList.toggle("active");
      state.statusFilter.has(v) ? state.statusFilter.delete(v) : state.statusFilter.add(v);
      render();
    });
  });
  // 色フィルター
  document.querySelectorAll(".chip-color").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.color;
      b.classList.toggle("active");
      state.colorFilter.has(v) ? state.colorFilter.delete(v) : state.colorFilter.add(v);
      render();
    });
  });
  // 並べ替え
  $("sort").addEventListener("change", () => { state.sort = $("sort").value; render(); });
  // フォロー率上限
  $("ratio-max").addEventListener("input", () => {
    const v = $("ratio-max").value;
    state.ratioMax = v === "" ? null : Number(v);
    render();
  });

  // モーダル
  document.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => {
      if (el.closest("#lightbox")) { $("lightbox").hidden = true; }
      else closeModal();
    })
  );
  // 拡大表示: 背景クリックで閉じる / 前後ボタン
  $("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });
  $("lightbox-prev").addEventListener("click", (e) => { e.stopPropagation(); lightboxStep(-1); });
  $("lightbox-next").addEventListener("click", (e) => { e.stopPropagation(); lightboxStep(1); });
  // キーボード: ←→で移動・Escで閉じる
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").hidden) return;
    if (e.key === "ArrowLeft") lightboxStep(-1);
    else if (e.key === "ArrowRight") lightboxStep(1);
    else if (e.key === "Escape") closeLightbox();
  });
  $("modal-save").addEventListener("click", saveItem);
  $("modal-delete").addEventListener("click", deleteItem);
  $("f-xlink").addEventListener("input", () => {
    const id = parseXId($("f-xlink").value);
    if (id) {
      $("f-xid").value = id;
      if (!$("f-name").value) $("f-name").value = id;
    }
  });
  $("f-followers").addEventListener("input", updateRatioPreview);
  $("f-following").addEventListener("input", updateRatioPreview);
  $("f-photos").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    for (const f of files) {
      try {
        const data = await compressImage(f);
        state.draftPhotos.push(data);
      } catch (_) { toast("画像の読み込みに失敗しました"); }
    }
    renderDraftPhotos();
    e.target.value = "";
  });
  $("add-sns").addEventListener("click", () => addSubRow($("sns-list"), "種類（例: Instagram）"));
  $("add-pr").addEventListener("click", () => addSubRow($("pr-list"), "ラベル（例: PR投稿）"));
}

boot();
