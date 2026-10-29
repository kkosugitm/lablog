// LabLog ダッシュボード。PC ではサーバー（127.0.0.1）とだけ通信する。
// iPhone・iPad 用ビューアーでは同じ画面を使い、データは cloud.js が OneDrive から読む（要約だけ）。
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");
const state = { status: null, settings: null, refreshTimer: null, tips: [] };
const HOUR = 3600;
const cloud = window.LabLogCloud; // ビューアーのときだけある
const touch = matchMedia("(hover: none)").matches;

// ------------------------------------------------------------ 通信

async function toJson(res) {
  const data = await res.json().catch(() => ({ error: "応答を読み取れませんでした" }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const api = cloud ? {
  get: cloud.api.get,
  // 直した内容は PC が取り込むまで「反映待ち」になるので、上部のお知らせも出し直す
  post: (path, body) => cloud.api.post(path, body).then((res) => { refreshStatus(); return res; }),
} : {
  get: (path) => fetch(path, { cache: "no-store" }).then(toJson),
  post: (path, body) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-LabLog": "1" },
    body: JSON.stringify(body || {}),
  }).then(toJson),
};

// ------------------------------------------------------------ 書式

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtDur(sec) {
  const m = Math.round((sec || 0) / 60);
  const h = Math.floor(m / 60), r = m % 60;
  if (h && r) return `${h}時間${r}分`;
  if (h) return `${h}時間`;
  return `${r}分`;
}
function fmtClock(sec) {
  const m = Math.round((sec || 0) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
function fmtHM(ts) {
  const d = new Date(ts * 1000);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// その日（朝5時区切り）の基準日と比べて、日付をまたいでいれば「翌」を付ける
function fmtHMDay(ts, dayStart) {
  const base = new Date(dayStart * 1000), d = new Date(ts * 1000);
  const nextDay = d.getDate() !== base.getDate() || d.getMonth() !== base.getMonth();
  return (nextDay ? "翌" : "") + fmtHM(ts);
}
function toLocalInput(ts) {
  const d = new Date(ts * 1000 - new Date(ts * 1000).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtWhen(ts) {
  const d = new Date(ts * 1000), now = new Date();
  return d.toDateString() === now.toDateString() ? fmtHM(ts) : `${d.getMonth() + 1}/${d.getDate()} ${fmtHM(ts)}`;
}
function safeHref(url) {
  return /^(https?|file):/i.test(url) ? esc(url) : "#";
}
function flash(msg) {
  const el = document.createElement("div");
  el.className = "toast-msg";
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

// 分類の色：設定の順番で固定。9 番目以降と「その他」はグレー。
function catColor(name, names) {
  if (name === "idle") return "var(--c-idle)";
  const i = names.indexOf(name);
  if (name === "その他" || i < 0 || i >= 8) return "var(--c-other)";
  return `var(--c${i + 1})`;
}

// ------------------------------------------------------------ ツールチップ

function tipAttr(html) {
  state.tips.push(html);
  return `data-tip="${state.tips.length - 1}"`;
}
const tip = $("#tip");
function placeTip(x0, y0) {
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = x0 + pad, y = y0 + pad;
  if (x + w > innerWidth - 8) x = x0 - w - pad;
  if (y + h > innerHeight - 8) y = y0 - h - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function showTip(el) {
  tip.innerHTML = state.tips[Number(el.dataset.tip)] || "";
  tip.hidden = false;
}
// マウスは重ねたときに出す。タッチは触れた場所に出す（リンクやボタンはそのまま押せるようにする）
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const el = e.target.closest("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  showTip(el);
});
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && !tip.hidden) placeTip(e.clientX, e.clientY);
});
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  const el = e.target.closest("[data-tip]");
  if (!el || el.closest("a, button")) { tip.hidden = true; return; }
  showTip(el);
  placeTip(e.clientX, e.clientY);
});
document.addEventListener("mouseleave", () => { tip.hidden = true; });
window.addEventListener("scroll", () => { if (touch) tip.hidden = true; }, { passive: true });

// ------------------------------------------------------------ 上部バー

const STATE_LABEL = { in: "在学中", tentative: "仮退出中", out: "学外" };
const NET_LABEL = { univ: "大学", home: "自宅", other: "未登録", offline: "" };

function renderStatus() {
  const s = state.status;
  if (!s) return;
  if (cloud) return renderCloudStatus(s);
  const parts = [];
  if (s.paused) {
    parts.push(`<span class="pill paused"><span class="dot"></span>記録を一時停止中</span>`);
  }
  const since = s.state === "in" ? `（${fmtHM(s.since)}〜）`
    : s.state === "tentative" ? `（${fmtHM(s.since)}〜）` : "";
  parts.push(`<span class="pill ${esc(s.state)}"><span class="dot"></span>${STATE_LABEL[s.state] || ""}${since}</span>`);
  const net = s.ssids && s.ssids.length
    ? `Wi-Fi：${esc(s.ssids.join(", "))}${NET_LABEL[s.net] ? `（${NET_LABEL[s.net]}）` : ""}`
    : "Wi-Fi：未接続";
  parts.push(`<span class="net">${net}</span>`);
  $("#status").innerHTML = parts.join("");
  const btn = $("#pause");
  btn.textContent = s.paused ? "記録を再開" : "一時停止";
  btn.classList.toggle("btn-primary", !!s.paused);
  renderNotices();
}

// ビューアー：PC が最後に書き出した時点の状態を出す
function renderCloudStatus(s) {
  const parts = [];
  if (s.paused) parts.push(`<span class="pill paused"><span class="dot"></span>記録を一時停止中</span>`);
  if (s.state !== "none") {
    const stale = s.exported && Date.now() / 1000 - s.exported > 15 * 60;
    const since = ["in", "tentative"].includes(s.state) && s.since ? `（${fmtHM(s.since)}〜）` : "";
    parts.push(`<span class="pill ${esc(s.state)} ${stale ? "stale" : ""}"><span class="dot"></span>${STATE_LABEL[s.state] || ""}${since}</span>`);
    parts.push(`<span class="net">PC の最終更新：${s.exported ? fmtWhen(s.exported) : "—"}</span>`);
  }
  $("#status").innerHTML = parts.join("");
  renderNotices();
}

function renderNotices() {
  const s = state.status, settings = state.settings && state.settings.settings;
  const items = [];
  if (cloud && s) {
    if (s.state === "none") items.push(["warn", "まだ PC から記録が届いていません。PC の LabLog が動いていれば、数分で表示されます。"]);
    if (s.offline) items.push(["warn", "インターネットにつながらないため、前に読み込んだ内容を表示しています。"]);
    if (s.pending) items.push(["warn", `直した内容（${s.pending} 件）は、PC の LabLog が次に動いたときに反映されます。`]);
  }
  if (s && s.wifi_error) items.push(["error", esc(s.wifi_error)]);
  if (settings && !settings.wifi.univ.length) {
    items.push(["warn", `大学の Wi-Fi がまだ登録されていません。研究室にいるときに <a href="#/settings">設定</a> の「大学として登録」を押してください（研究室専用と大学共通の両方）。`]);
  }
  if (settings && !settings.watch_folders.length) {
    items.push(["warn", `監視するフォルダがまだありません。<a href="#/settings">設定</a> から研究フォルダ（ResearchM2 など）を追加すると、編集したファイルや Git のコミットも記録されます。`]);
  }
  $("#notices").innerHTML = items.map(([kind, html]) =>
    `<div class="notice ${kind}"><span class="ico">!</span><div>${html}</div></div>`).join("");
}

async function refreshStatus() {
  try {
    state.status = await api.get("/api/status");
    renderStatus();
  } catch (e) { /* サーバー再起動中など。次の更新で戻る */ }
}

$("#pause").addEventListener("click", async () => {
  if (cloud) { // ビューアーでは「更新」ボタン
    cloud.clearCache();
    await refreshStatus();
    await route();
    flash("最新の内容を読み込みました");
    return;
  }
  const paused = !(state.status && state.status.paused);
  if (paused && !confirm("作業内容の記録（ウィンドウ・ファイル・履歴）を一時停止します。入退室の判定は続けます。よろしいですか？")) return;
  state.status = await api.post("/api/pause", { paused });
  renderStatus();
  flash(paused ? "記録を一時停止しました" : "記録を再開しました");
});

// ------------------------------------------------------------ 画面の切り替え

function setTab(name) {
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
}

async function route() {
  clearTimeout(state.refreshTimer);
  state.tips = [];
  tip.hidden = true;
  const [, page, arg] = (location.hash || "#/day").split("/");
  try {
    if (page === "month") { setTab("month"); await renderMonth(arg); }
    else if (page === "settings" && !cloud) { setTab("settings"); await renderSettings(); }
    else { setTab("day"); await renderDay(arg); }
  } catch (e) {
    if (e.name === "SignInRequired") return renderSignIn();
    view.innerHTML = `<div class="card"><b>読み込めませんでした</b><p class="muted">${esc(e.message)}</p></div>`;
  }
}

// ------------------------------------------------------------ 日別

async function renderDay(dateArg, { keepScroll = false } = {}) {
  const today = (state.status && state.status.today) || isoDate(new Date());
  const date = dateArg || today;
  const day = await api.get(`/api/day?date=${encodeURIComponent(date)}`);
  const scrollY = window.scrollY;
  state.tips = [];
  const names = day.category_names;
  const firstIn = day.stays.length ? day.stays[0].start : null;
  const lastStay = day.stays[day.stays.length - 1];
  const outLabel = !lastStay ? "—"
    : lastStay.state === "in" ? "在学中"
    : lastStay.state === "tentative" ? `仮退出 ${fmtHMDay(lastStay.end, day.range[0])}`
    : fmtHMDay(lastStay.end, day.range[0]);
  const loc = day.work_by_location;
  const locText = ["大学", "自宅", "その他"].filter((k) => loc[k] >= 60)
    .map((k) => `${k} ${fmtDur(loc[k])}`).join("・") || "記録なし";

  view.innerHTML = `
    <div class="page-head">
      <a class="btn btn-ghost" href="#/day/${addDays(day.date, -1)}" aria-label="前の日">‹</a>
      <h1>${esc(day.date_label)}</h1>
      <a class="btn btn-ghost" href="#/day/${addDays(day.date, 1)}" aria-label="次の日">›</a>
      ${day.is_today ? "" : `<a class="btn" href="#/day/${today}">今日</a>`}
      <input type="date" id="pick-date" value="${esc(day.date)}" aria-label="日付を選ぶ">
    </div>

    <div class="tiles">
      <div class="tile"><div class="label">入室</div>
        <div class="value num">${firstIn ? fmtHM(firstIn) : "—"}</div>
        <div class="foot">${day.stays.length > 1 ? `出入り ${day.stays.length} 回` : "大学の Wi-Fi に接続した時刻"}</div></div>
      <div class="tile"><div class="label">退室</div>
        <div class="value num">${esc(outLabel)}</div>
        <div class="foot">${lastStay && lastStay.state === "tentative" ? "4時間以内に戻れば滞在が続きます" : "Wi-Fi が切れた時刻"}</div></div>
      <div class="tile"><div class="label">滞在時間</div>
        <div class="value">${day.stays.length ? esc(fmtDur(day.stay_total)) : "—"}</div>
        <div class="foot">PC を閉じていた時間も含む</div></div>
      <div class="tile"><div class="label">PC作業時間</div>
        <div class="value">${esc(fmtDur(day.work_total))}</div>
        <div class="foot">${esc(locText)}</div></div>
    </div>

    <div class="grid">
      <section class="card span-2" id="report-card"></section>
      <section class="card span-2">
        <div class="card-head"><h2>タイムライン</h2><span class="sub">ブロックに${touch ? "触れる" : "マウスを重ねる"}と内容が出ます</span></div>
        ${timelineHTML(day, names)}
      </section>
      <section class="card">
        <div class="card-head"><h2>分類別の時間</h2><span class="sub">PC作業 ${esc(fmtDur(day.work_total))}</span></div>
        ${categoryBarsHTML(day, names)}
      </section>
      <section class="card">
        <div class="card-head"><h2>大学での滞在</h2><span class="spacer"></span>
          <button class="btn btn-sm" id="add-stay">＋ 追加</button></div>
        <div id="stays">${staysHTML(day)}</div>
      </section>
      ${cloud ? "" : `<section class="card">
        <div class="card-head"><h2>アプリ・ウィンドウ</h2><span class="sub">${day.apps.length} 個のアプリ</span></div>
        <div class="scroll">${appsHTML(day, names)}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>編集したファイル</h2><span class="sub">${day.files_total} 件</span></div>
        <div class="scroll">${filesHTML(day)}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Git</h2><span class="sub">コミット ${day.commits.length} 件</span></div>
        ${gitHTML(day)}
      </section>
      <section class="card">
        <div class="card-head"><h2>開いたファイル</h2><span class="sub">Windows の「最近使ったファイル」</span></div>
        <div class="scroll">${recentHTML(day)}</div>
      </section>
      <section class="card span-2">
        <div class="card-head"><h2>閲覧したページ</h2><span class="sub">Chrome・Edge ${day.web_total} 件</span></div>
        <div class="scroll">${webHTML(day, names)}</div>
      </section>`}
    </div>`;

  renderReport(day);
  $("#pick-date").addEventListener("change", (e) => { if (e.target.value) location.hash = `#/day/${e.target.value}`; });
  $("#add-stay").addEventListener("click", () => openStayForm(day, null));
  $$("[data-edit-stay]").forEach((b) => b.addEventListener("click", () =>
    openStayForm(day, day.stays.find((s) => s.id === Number(b.dataset.editStay)))));
  if (keepScroll) window.scrollTo(0, scrollY);

  if (day.is_today) {
    state.refreshTimer = setTimeout(() => {
      const editing = document.activeElement && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);
      if (editing || state.reportDirty || $("#stay-form")) {
        state.refreshTimer = setTimeout(() => renderDay(dateArg, { keepScroll: true }), 60000);
      } else {
        renderDay(dateArg, { keepScroll: true }).catch(() => {});
      }
    }, 60000);
  }
}

function timelineHTML(day, names) {
  const [t0, t1] = day.range;
  let lo = Infinity, hi = -Infinity;
  for (const b of day.timeline) { lo = Math.min(lo, b.start); hi = Math.max(hi, b.end); }
  for (const s of day.stays) { lo = Math.min(lo, s.start); hi = Math.max(hi, s.end); }
  if (!isFinite(lo)) return `<div class="empty">この日の記録はまだありません。</div>`;
  if (day.is_today) hi = Math.max(hi, Math.min(day.now, t1));
  let vs = t0 + Math.floor((lo - t0) / HOUR) * HOUR;
  let ve = t0 + Math.ceil((hi - t0) / HOUR) * HOUR;
  if (ve - vs < 6 * HOUR) { ve = Math.min(t1, vs + 6 * HOUR); vs = Math.max(t0, ve - 6 * HOUR); }
  const span = ve - vs;
  const L = (t) => `${(((t - vs) / span) * 100).toFixed(3)}%`;
  const W = (a, b) => `${((Math.max(0, b - a) / span) * 100).toFixed(3)}%`;

  const step = span > 12 * HOUR ? 2 * HOUR : HOUR;
  let ticks = "", grid = "";
  for (let t = vs; t <= ve + 1; t += step) {
    ticks += `<span class="tl-tick" style="left:${L(t)}">${new Date(t * 1000).getHours()}</span>`;
    grid += `<span class="tl-grid" style="left:calc(${L(t)})"></span>`;
  }

  const stays = day.stays.map((s) => {
    const label = s.state === "tentative" ? "仮退出中" : "大学";
    return `<span class="tl-stay ${s.state === "tentative" ? "tentative" : ""}" style="left:${L(Math.max(s.start, vs))};width:${W(Math.max(s.start, vs), Math.min(s.end, ve))}"
      ${tipAttr(`<b>${label}</b><div>${fmtHMDay(s.start, t0)}〜${fmtHMDay(s.end, t0)}（${fmtDur(s.duration)}）</div>`)}></span>`;
  }).join("");

  const blocks = day.timeline.map((b) => {
    const isIdle = b.cat === "idle";
    const rows = b.top.map((it) => `<div class="t-row"><span>${esc(it.label)}</span><span>${fmtDur(it.sec)}</span></div>`).join("");
    const head = isIdle ? "離席（操作なし）" : esc(b.cat);
    return `<span class="tl-block ${isIdle ? "idle" : ""}" style="left:${L(b.start)};width:${W(b.start, b.end)};${isIdle ? "" : `background:${catColor(b.cat, names)}`}"
      ${tipAttr(`<b>${head}</b><div>${fmtHMDay(b.start, t0)}〜${fmtHMDay(b.end, t0)}（${fmtDur(b.end - b.start)}）</div>${rows}`)}></span>`;
  }).join("");

  const now = day.is_today && day.now > vs && day.now < ve
    ? `<span class="tl-now" style="left:${L(day.now)}" ${tipAttr(`<b>${cloud ? "PC の最終更新" : "現在"}</b> ${fmtHM(day.now)}`)}></span>` : "";
  const used = names.filter((n) => day.timeline.some((b) => b.cat === n));
  const legend = used.map((n) => `<span><i class="sw" style="background:${catColor(n, names)}"></i>${esc(n)}</span>`).join("")
    + `<span><i class="sw" style="background:repeating-linear-gradient(135deg, var(--c-idle) 0 2px, transparent 2px 4px)"></i>離席</span>`
    + `<span><i class="sw" style="background:var(--stay)"></i>大学にいた時間</span>`;

  return `<div class="tl">
      <div style="position:absolute;inset:0 0 0 64px">${grid}${now}</div>
      <div class="tl-row"><span class="tl-label">大学</span><div class="tl-track" style="background:transparent">${stays}</div></div>
      <div class="tl-row"><span class="tl-label">PC作業</span><div class="tl-track">${blocks}</div></div>
      <div class="tl-axis">${ticks}</div>
    </div>
    <div class="legend">${legend}</div>`;
}

function categoryBarsHTML(day, names) {
  if (!day.categories.length) return `<div class="empty">まだ PC 作業の記録がありません。</div>`;
  const cats = [...day.categories].sort((a, b) => b.sec - a.sec);
  const max = cats[0].sec;
  return `<div class="bars">${cats.map((c) => `
    <div class="bar-row" ${tipAttr(`<b>${esc(c.name)}</b><div>${fmtDur(c.sec)}（${Math.round((c.sec / day.work_total) * 100)}%）</div>`)}>
      <span class="name"><i class="sw" style="background:${catColor(c.name, names)}"></i>${esc(c.name)}</span>
      <span class="bar-track"><span class="bar" style="display:block;width:${((c.sec / max) * 100).toFixed(2)}%;background:${catColor(c.name, names)}"></span></span>
      <span class="val">${fmtDur(c.sec)}</span>
    </div>`).join("")}</div>`;
}

const REASON = { offcampus: "大学外の Wi-Fi に接続", timeout: "4時間戻らず", idle: "4時間操作なし", manual: "手動で修正" };

function staysHTML(day) {
  if (!day.stays.length) return `<div class="empty">この日は大学の Wi-Fi への接続がありません。</div>`;
  return `<div class="stay-list">${day.stays.map((s) => `
    <div class="stay-row">
      <span class="time">${fmtHMDay(s.start, day.range[0])} 〜 ${s.state === "in" ? "在学中" : fmtHMDay(s.end, day.range[0])}</span>
      <span class="ink2">${fmtDur(s.duration)}</span>
      ${s.state === "tentative" ? `<span class="tag warn">仮退出中</span>` : ""}
      ${s.reason ? `<span class="tag">${esc(REASON[s.reason] || s.reason)}</span>` : ""}
      ${s.pending ? `<span class="tag warn">PC へ反映待ち</span>` : ""}
      <span class="spacer"></span>
      ${s.id == null ? "" : `<button class="btn btn-sm btn-ghost" data-edit-stay="${s.id}">編集</button>`}
    </div>`).join("")}</div>`;
}

function openStayForm(day, stay) {
  const box = $("#stays");
  const startDefault = stay ? stay.start : day.range[0] + 4 * HOUR;
  const endDefault = stay ? (stay.state === "in" ? null : stay.end) : day.range[0] + 13 * HOUR;
  box.innerHTML = `<form id="stay-form" class="stay-list">
      <label class="field"><span>入室</span><input type="datetime-local" name="start" required value="${toLocalInput(startDefault)}"></label>
      <label class="field"><span>退室${stay && stay.state === "in" ? "（空欄なら在学中のまま）" : ""}</span>
        <input type="datetime-local" name="end" ${stay && stay.state === "in" ? "" : "required"} value="${endDefault ? toLocalInput(endDefault) : ""}"></label>
      <div class="row">
        <button class="btn btn-primary" type="submit">保存</button>
        <button class="btn" type="button" id="stay-cancel">キャンセル</button>
        <span class="spacer"></span>
        ${stay ? `<button class="btn btn-danger" type="button" id="stay-delete">この滞在を削除</button>` : ""}
      </div>
    </form>`;
  const form = $("#stay-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.post("/api/stay/save", { id: stay ? stay.id : null, start: form.start.value, end: form.end.value || null, date: day.date });
      flash("滞在を保存しました");
      renderDay(day.date, { keepScroll: true });
    } catch (err) { alert(err.message); }
  });
  $("#stay-cancel").addEventListener("click", () => renderDay(day.date, { keepScroll: true }));
  const del = $("#stay-delete");
  if (del) del.addEventListener("click", async () => {
    if (!confirm("この滞在の記録を削除します。よろしいですか？")) return;
    await api.post("/api/stay/delete", { id: stay.id, date: day.date }).catch((err) => alert(err.message));
    renderDay(day.date, { keepScroll: true });
  });
}

function appsHTML(day, names) {
  if (!day.apps.length) return `<div class="empty">まだ記録がありません。</div>`;
  return day.apps.map((a) => `
    <details class="group">
      <summary><i class="sw" style="background:${catColor(a.category, names)}"></i>
        <span class="name">${esc(a.app || "（不明）")}</span><span class="side muted num">${fmtDur(a.total)}</span></summary>
      <div class="inner list">${a.titles.map((t) => `
        <div class="list-item"><span class="main">${esc(t.title)}</span><span class="side">${fmtDur(t.sec)}</span></div>`).join("")}
        ${a.more ? `<div class="list-item muted">ほか ${a.more} 件</div>` : ""}
      </div>
    </details>`).join("");
}

function filesHTML(day) {
  if (!day.files.length) {
    const hasFolders = state.settings && state.settings.settings.watch_folders.length;
    return `<div class="empty">${hasFolders ? "この日に編集したファイルはありません。" : `監視フォルダが未登録です。<a href="#/settings">設定</a>から追加してください。`}</div>`;
  }
  return `<div class="list">${day.files.map((f) => {
    const tags = [];
    if (f.added) tags.push("新規");
    if (f.saves) tags.push(`保存 ${f.saves}回`);
    if (f.renamed_from) tags.push(`名前変更（${esc(f.renamed_from)} から）`);
    if (f.removed) tags.push("削除");
    return `<div class="list-item" ${tipAttr(`<div>${esc(f.path)}</div>`)}>
      <span class="main">${esc(f.rel)} ${tags.map((t) => `<span class="tag">${t}</span>`).join(" ")}</span>
      <span class="side">${fmtHMDay(f.last, day.range[0])}</span></div>`;
  }).join("")}</div>`;
}

function gitHTML(day) {
  const parts = [];
  if (day.commits.length) {
    parts.push(`<div class="list">${day.commits.map((c) => `
      <div class="list-item"><span class="main"><span class="tag">${esc(c.repo)}</span> ${esc(c.subject)}</span>
      <span class="side">${fmtHMDay(c.ts, day.range[0])}</span></div>`).join("")}</div>`);
  } else {
    parts.push(`<div class="empty">この日のコミットはありません。</div>`);
  }
  const repos = (state.status && state.status.repos) || [];
  if (day.is_today && repos.length) {
    const hours = state.settings ? state.settings.settings.git_notify.hours : 2;
    const now = Date.now() / 1000;
    parts.push(`<div class="card-head" style="margin:14px 0 6px"><h2 style="font-size:13px">いまの状態</h2></div><div class="list">${repos.map((r) => {
      const since = r.last_commit_ts ? fmtDur(now - r.last_commit_ts) + "前" : "コミットなし";
      const from = Math.max(r.dirty_since || now, r.last_commit_ts || 0);
      const late = r.dirty_files && now - from >= hours * HOUR;
      const dirty = r.dirty_files
        ? `<span class="tag ${late ? "warn" : ""}">${late ? "⚠ " : ""}未コミット ${r.dirty_files} 件</span>` : `<span class="tag">変更なし</span>`;
      return `<div class="list-item" ${tipAttr(esc(r.repo))}><span class="main"><b>${esc(r.name)}</b> <span class="muted">${esc(r.branch || "")}</span> ${dirty}</span>
        <span class="side">最後のコミット ${since}</span></div>`;
    }).join("")}</div>`);
  }
  return parts.join("");
}

function recentHTML(day) {
  if (!day.recent.length) return `<div class="empty">記録がありません。</div>`;
  return `<div class="list">${day.recent.map((r) => `
    <div class="list-item" ${tipAttr(esc(r.path))}><span class="main">${esc(r.name)}</span>
    <span class="side">${fmtHMDay(r.ts, day.range[0])}</span></div>`).join("")}</div>`;
}

function webHTML(day, names) {
  if (!day.web.length) return `<div class="empty">記録がありません。</div>`;
  return day.web.map((d) => `
    <details class="group">
      <summary><i class="sw" style="background:${catColor(d.category, names)}"></i>
        <span class="name">${esc(d.domain)}</span><span class="side muted num">${d.count} 回</span></summary>
      <div class="inner list">${d.pages.map((p) => `
        <div class="list-item"><span class="main"><a href="${safeHref(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title || p.url)}</a></span>
        <span class="side">${fmtHMDay(p.first, day.range[0])}${p.count > 1 ? `・${p.count}回` : ""}</span></div>`).join("")}
        ${d.more ? `<div class="list-item muted">ほか ${d.more} 件</div>` : ""}
      </div>
    </details>`).join("");
}

// ---- 日報

function reportMeta(r) {
  if (!r) return "まだ作成されていません。退出が確定したときと、日付が変わったときに自動で作ります。";
  if (r.pending) return "保存しました（PC の LabLog が次に動いたときに反映されます）";
  if (r.edited) return "自分で編集した日報です（自動では上書きしません）";
  const when = r.generated_ts ? `${new Date(r.generated_ts * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} に作成` : "";
  if ((r.source || "").startsWith("ai:")) return `ローカルAI（${esc(r.source.slice(3))}）が作成した下書き・${when}`;
  return `集計から作成した下書き・${when}（ローカルAIを設定すると文章で要約します）`;
}

function fitTextarea(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.max(180, ta.scrollHeight + 4)}px`;
}
// 画面の幅が変わったとき（iPhone・iPad の向きを変えたときなど）に日報の欄の高さを合わせ直す
window.addEventListener("resize", () => { const ta = $("#report-text"); if (ta) fitTextarea(ta); });

function renderReport(day) {
  const card = $("#report-card");
  const r = day.report;
  state.reportDirty = false;
  card.innerHTML = `
    <div class="card-head"><h2>日報</h2><span class="report-meta" id="report-meta">${reportMeta(r)}</span>
      <span class="spacer"></span>
      ${cloud ? "" : `<button class="btn" id="report-gen">${r && r.text ? "下書きを作り直す" : "下書きを作成"}</button>`}
      <button class="btn btn-primary" id="report-save" disabled>保存</button></div>
    <textarea id="report-text" placeholder="ここに今日やったことをメモできます。「下書きを作成」で、記録から自動で下書きを作ります。">${esc(r ? r.text : "")}</textarea>`;
  const ta = $("#report-text"), save = $("#report-save"), gen = $("#report-gen");
  const fit = () => fitTextarea(ta);
  fit();
  ta.addEventListener("input", () => { state.reportDirty = true; save.disabled = false; fit(); });
  save.addEventListener("click", async () => {
    try {
      await api.post("/api/report/save", { date: day.date, text: ta.value });
    } catch (err) { alert(err.message); return; }
    state.reportDirty = false;
    save.disabled = true;
    $("#report-meta").textContent = reportMeta({ edited: 1, pending: !!cloud });
    flash("日報を保存しました");
  });
  if (gen) gen.addEventListener("click", async () => {
    const edited = (r && r.edited) || state.reportDirty;
    if (edited && !confirm("編集した内容を、記録から作った下書きで置き換えます。よろしいですか？")) return;
    gen.disabled = true;
    save.disabled = true;
    const label = gen.textContent;
    gen.textContent = "作成中…";
    $("#report-meta").textContent = "作成中です。ローカルAIを使う場合は1分前後かかります。";
    try {
      const res = await api.post("/api/report/generate", { date: day.date, force: true });
      ta.value = res.text || "";
      fit();
      state.reportDirty = false;
      $("#report-meta").innerHTML = reportMeta(res);
      day.report = res;
    } catch (err) {
      alert(err.message);
      $("#report-meta").innerHTML = reportMeta(r);
    } finally {
      gen.disabled = false;
      gen.textContent = label;
    }
  });
}

// ------------------------------------------------------------ 月

async function renderMonth(monthArg) {
  const today = (state.status && state.status.today) || isoDate(new Date());
  const month = monthArg || today.slice(0, 7);
  const m = await api.get(`/api/month?month=${encodeURIComponent(month)}`);
  const [y, mo] = month.split("-").map(Number);
  const maxStay = Math.max(HOUR, ...m.days.map((d) => d.stay));
  const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7; // 月曜始まり
  const avg = m.stay_days ? m.stay_total / m.stay_days : 0;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<div class="cell blank"></div>`);
  for (const d of m.days) {
    const n = Number(d.date.slice(8));
    const tipHtml = `<b>${esc(d.date)}</b>`
      + (d.stay ? `<div>大学 ${fmtHM(d.first_in)}〜${fmtHM(d.last_out)}（${fmtDur(d.stay)}）</div>` : `<div>大学：なし</div>`)
      + `<div>PC作業 ${fmtDur(d.work)}</div>`
      + Object.entries(d.by_location).filter(([, v]) => v >= 60).map(([k, v]) => `<div class="t-row"><span>${esc(k)}</span><span>${fmtDur(v)}</span></div>`).join("");
    cells.push(`<a class="cell ${d.date === today ? "today" : ""}" href="#/day/${d.date}" ${tipAttr(tipHtml)}>
      <span class="d"><span>${n}</span>${d.has_report ? `<span class="rep" title="日報あり"></span>` : ""}</span>
      ${d.stay ? `<span class="st">${fmtClock(d.stay)}</span>` : `<span class="st muted">—</span>`}
      ${d.work ? `<span class="wk">PC ${fmtClock(d.work)}</span>` : ""}
      <span class="meter"><i style="width:${((d.stay / maxStay) * 100).toFixed(1)}%"></i></span>
    </a>`);
  }
  view.innerHTML = `
    <div class="page-head">
      <a class="btn btn-ghost" href="#/month/${addMonths(month, -1)}" aria-label="前の月">‹</a>
      <h1>${y}年${mo}月</h1>
      <a class="btn btn-ghost" href="#/month/${addMonths(month, 1)}" aria-label="次の月">›</a>
      <span class="spacer"></span>
      ${cloud ? `<button class="btn" id="csv">CSV で書き出す</button>`
        : `<a class="btn" href="/api/export/stays.csv?month=${esc(month)}">CSV で書き出す</a>`}
    </div>
    <div class="tiles">
      <div class="tile"><div class="label">大学にいた日数</div><div class="value">${m.stay_days}<small>日</small></div></div>
      <div class="tile"><div class="label">滞在時間の合計</div><div class="value">${esc(fmtDur(m.stay_total))}</div></div>
      <div class="tile"><div class="label">1日あたりの滞在</div><div class="value">${m.stay_days ? esc(fmtDur(avg)) : "—"}</div>
        <div class="foot">大学にいた日の平均</div></div>
      <div class="tile"><div class="label">PC作業時間の合計</div><div class="value">${esc(fmtDur(m.work_total))}</div>
        <div class="foot">自宅などでの作業も含む</div></div>
    </div>
    <section class="card">
      <div class="card-head"><h2>カレンダー</h2><span class="sub">大きい数字：大学の滞在時間（時:分）／ 小さい数字：PC作業時間 ／ 青い点：日報あり</span></div>
      <div class="cal">${["月", "火", "水", "木", "金", "土", "日"].map((w) => `<div class="dow">${w}</div>`).join("")}${cells.join("")}</div>
    </section>`;
  if (cloud) $("#csv").addEventListener("click", () => downloadCSV(m));
}

// PC の「CSV で書き出す」と同じ形式（Excel で文字化けしないよう BOM 付き）
function downloadCSV(m) {
  const min = (sec) => Math.round((sec || 0) / 60);
  const hm = (ts) => fmtHM(ts).padStart(5, "0");
  const rows = [["日付", "曜日", "最初の入室", "最後の退室", "滞在時間", "滞在(分)", "PC作業時間", "PC作業(分)", "うち大学(分)", "うち自宅(分)"]];
  for (const d of m.days) {
    rows.push([d.date, "日月火水木金土"[new Date(d.date + "T12:00:00").getDay()],
      d.first_in ? hm(d.first_in) : "", d.last_out ? hm(d.last_out) : "",
      d.stay ? fmtDur(d.stay) : "", min(d.stay), d.work ? fmtDur(d.work) : "", min(d.work),
      min(d.by_location["大学"]), min(d.by_location["自宅"])]);
  }
  const blob = new Blob(["\ufeff" + rows.map((r) => r.join(",")).join("\r\n") + "\r\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lablog_${m.month}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ------------------------------------------------------------ 設定

async function loadSettings() {
  state.settings = await api.get("/api/settings");
  return state.settings;
}

async function saveSettings(patch, msg = "保存しました") {
  try {
    await api.post("/api/settings", patch);
    await loadSettings();
    renderNotices();
    flash(msg);
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

const lines = (text) => text.split(/[\n,、]/).map((s) => s.trim()).filter(Boolean);

async function renderSettings() {
  const { settings: s, data_dir: dataDir, repos, ssids } = await loadSettings();
  const current = ssids && ssids[0];
  const where = !current ? "未接続" : s.wifi.univ.includes(current) ? "大学として登録済み"
    : s.wifi.home.includes(current) ? "自宅として登録済み" : "未登録";
  const ssidList = (kind) => s.wifi[kind].length ? s.wifi[kind].map((x) => `
      <div class="set-item"><span class="main">${esc(x)}</span>
      <button class="icon-btn" data-wifi-remove="${esc(kind)}" data-ssid="${esc(x)}" aria-label="${esc(x)} を削除">✕</button></div>`).join("")
    : `<div class="empty">まだありません</div>`;

  const catNames = s.categories.map((c) => c.name).concat(["その他"]);

  view.innerHTML = `
    <div class="page-head"><h1>設定</h1></div>
    <div class="grid">
      <section class="card">
        <div class="card-head"><h2>Wi-Fi の登録</h2></div>
        <p class="help">いま接続中：<b>${esc(current || "なし")}</b>（${where}）</p>
        <div class="row">
          <button class="btn btn-primary" data-wifi-register="univ" ${current ? "" : "disabled"}>大学として登録</button>
          <button class="btn" data-wifi-register="home" ${current ? "" : "disabled"}>自宅として登録</button>
        </div>
        <p class="help">研究室専用の Wi-Fi と大学共通の Wi-Fi は、どちらも「大学」として登録してください。</p>
        <h3 class="help" style="margin-top:12px">大学</h3><div class="set-list">${ssidList("univ")}</div>
        <h3 class="help">自宅</h3><div class="set-list">${ssidList("home")}</div>
      </section>

      <section class="card">
        <div class="card-head"><h2>監視するフォルダ</h2></div>
        <p class="help">フォルダ内で作成・保存・削除したファイルと、その中の Git リポジトリのコミットを記録します（ファイルの中身は読みません）。</p>
        <div class="set-list">${s.watch_folders.length ? s.watch_folders.map((f) => `
          <div class="set-item"><span class="main">${esc(f)}</span>
          <button class="icon-btn" data-folder-remove="${esc(f)}" aria-label="削除">✕</button></div>`).join("") : `<div class="empty">まだありません</div>`}</div>
        <div class="row">
          <button class="btn btn-primary" id="folder-pick">フォルダを選んで追加…</button>
        </div>
        <form class="row" id="folder-form" style="margin-top:8px">
          <input type="text" name="path" placeholder="または、フォルダのパスを貼り付け" style="flex:1;min-width:200px">
          <button class="btn" type="submit">追加</button>
        </form>
        <h3 class="help" style="margin-top:12px">見つかった Git リポジトリ</h3>
        <div class="set-list">${repos.length ? repos.map((r) => `<div class="set-item"><span class="main">${esc(r)}</span></div>`).join("")
          : `<div class="empty">まだ見つかっていません（フォルダ追加後、数秒〜数分で表示されます）</div>`}</div>
      </section>

      <section class="card">
        <div class="card-head"><h2>コミットの通知</h2></div>
        <form id="git-form">
          <label class="check"><input type="checkbox" name="enabled" ${s.git_notify.enabled ? "checked" : ""}> 未コミットのまま時間がたったら Windows の通知で知らせる</label>
          <label class="field" style="margin-top:10px"><span>知らせるまでの時間（時間）</span>
            <input type="number" name="hours" min="0.5" max="24" step="0.5" value="${s.git_notify.hours}" style="width:8em"></label>
          <p class="help">作業中（最近ファイルを編集した）のリポジトリだけが対象です。一度知らせたら、同じ時間がたつまで再通知しません。</p>
          <button class="btn btn-primary" type="submit">保存</button>
        </form>
      </section>

      <section class="card">
        <div class="card-head"><h2>ローカルAI（日報の要約）</h2></div>
        <p class="help" id="ollama-state"><span class="tag">確認中…</span></p>
        <form id="ollama-form">
          <label class="field"><span>モデル名</span><input type="text" name="model" value="${esc(s.ollama.model)}"></label>
          <label class="check"><input type="checkbox" name="auto" ${s.ollama.auto ? "checked" : ""}> 退出確定時と日付の切り替わりに、日報の下書きを自動で作る</label>
          <p class="help">接続先は PC 内（${esc(s.ollama.url)}）だけです。記録が外部に送られることはありません。</p>
          <button class="btn btn-primary" type="submit">保存</button>
        </form>
      </section>

      <section class="card">
        <div class="card-head"><h2>iPhone・iPad で見る</h2></div>
        <p class="help" id="cloud-state"><span class="tag">確認中…</span></p>
        <p class="help">OneDrive に置くのは要約だけです（入退室・PC作業時間・分類別の時間・日報）。ウィンドウ名・閲覧したページ・ファイルの場所は、この PC から出しません。</p>
        <form id="cloud-form" class="row">
          <label class="check"><input type="checkbox" name="enabled" ${s.cloud.enabled ? "checked" : ""}> OneDrive に書き出す</label>
          <span class="spacer"></span>
          <button class="btn" type="button" id="cloud-export">今すぐ書き出す</button>
          <button class="btn btn-primary" type="submit">保存</button>
        </form>
      </section>

      <section class="card">
        <div class="card-head"><h2>判定のしかた</h2></div>
        <form id="judge-form">
          <label class="field"><span>離席とみなす時間（操作がない分数）</span>
            <input type="number" name="idle" min="1" max="60" step="1" value="${s.idle_threshold_min}" style="width:8em"></label>
          <label class="field"><span>退出を確定するまでの時間（仮退出・操作なしの時間数）</span>
            <input type="number" name="leave" min="1" max="24" step="0.5" value="${s.leave_after_hours}" style="width:8em"></label>
          <button class="btn btn-primary" type="submit">保存</button>
        </form>
      </section>

      <section class="card">
        <div class="card-head"><h2>記録しないアプリ</h2></div>
        <p class="help">ここに入れたアプリは、使った時間だけを「(除外)」として残し、アプリ名とウィンドウ名は記録しません。実行ファイル名を 1 行に 1 つ（例：<code>line.exe</code>）。</p>
        <form id="exclude-form">
          <textarea name="apps" rows="4">${esc(s.excluded_apps.join("\n"))}</textarea>
          <div class="row" style="margin-top:8px">
            <label class="check"><input type="checkbox" name="chrome" ${s.browsers.chrome ? "checked" : ""}> Chrome の履歴を記録</label>
            <label class="check"><input type="checkbox" name="edge" ${s.browsers.edge ? "checked" : ""}> Edge の履歴を記録</label>
            <span class="spacer"></span>
            <button class="btn btn-primary" type="submit">保存</button>
          </div>
        </form>
      </section>

      <section class="card span-2">
        <div class="card-head"><h2>分類のルール</h2>
          <span class="sub">上から順に色が決まります。ドメインの先頭に「=」を付けると完全一致（例：=google.com は検索だけ）</span></div>
        <form id="cat-form">
          <div class="cat-edit cat-head"><span>分類名</span><span>アプリ（実行ファイル名）</span><span>サイト（ドメイン）</span><span>ウィンドウ名に含む語</span><span></span></div>
          <div id="cat-rows">${s.categories.map((c, i) => catRowHTML(c, i, catNames)).join("")}</div>
          <div class="row" style="margin-top:10px">
            <button class="btn" type="button" id="cat-add">＋ 分類を追加</button>
            <button class="btn btn-ghost" type="button" id="cat-reset">初期値に戻す</button>
            <span class="spacer"></span>
            <button class="btn btn-primary" type="submit">分類を保存</button>
          </div>
        </form>
      </section>

      <section class="card span-2">
        <div class="card-head"><h2>データの保存場所</h2></div>
        <p class="help"><code>${esc(dataDir)}</code><br>記録そのものは OneDrive の外に保存しているので、クラウドには同期されません（iPhone・iPad 用に書き出すのは要約だけです）。ダッシュボードはこの PC からだけ開けます。</p>
      </section>
    </div>`;

  api.get("/api/ollama").catch(() => ({ running: false })).then((o) => {
    const el = $("#ollama-state");
    if (!el) return;
    if (!o.running) {
      el.innerHTML = `<span class="tag warn">Ollama が起動していません</span> 日報は集計から作ります。`;
    } else if (!o.model_ready) {
      el.innerHTML = `<span class="tag warn">モデル ${esc(s.ollama.model)} が未ダウンロード</span> ターミナルで <code>ollama pull ${esc(s.ollama.model)}</code> を実行してください。`;
    } else {
      el.innerHTML = `<span class="tag">準備完了</span> ${esc(s.ollama.model)} で日報を要約します。`;
    }
  });
  loadCloudState();
  $("#cloud-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await saveSettings({ cloud: { ...s.cloud, enabled: e.target.enabled.checked } })) loadCloudState();
  });
  $("#cloud-export").addEventListener("click", async () => {
    await api.post("/api/cloud/export").catch((err) => alert(err.message));
    flash("書き出しを始めました");
    setTimeout(loadCloudState, 3000);
  });
  $$("[data-wifi-register]").forEach((b) => b.addEventListener("click", async () => {
    await api.post("/api/wifi/register", { kind: b.dataset.wifiRegister }).catch((e) => alert(e.message));
    flash("登録しました");
    renderSettings();
    refreshStatus();
  }));
  $$("[data-wifi-remove]").forEach((b) => b.addEventListener("click", async () => {
    await api.post("/api/wifi/remove", { kind: b.dataset.wifiRemove, ssid: b.dataset.ssid });
    renderSettings();
  }));
  $$("[data-folder-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`監視をやめます：\n${b.dataset.folderRemove}\n（これまでの記録は残ります）`)) return;
    await api.post("/api/folders/remove", { path: b.dataset.folderRemove });
    await loadSettings();
    renderSettings();
  }));
  $("#folder-pick").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "フォルダ選択画面を開いています…";
    try {
      const { path } = await api.post("/api/folders/pick");
      if (path) {
        await api.post("/api/folders/add", { path });
        flash("フォルダを追加しました");
        await loadSettings();
        renderNotices();
        setTimeout(renderSettings, 4000);
        renderSettings();
      }
    } catch (err) { alert(err.message); }
    finally { btn.disabled = false; btn.textContent = "フォルダを選んで追加…"; }
  });
  $("#folder-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.post("/api/folders/add", { path: e.target.path.value });
      flash("フォルダを追加しました");
      await loadSettings();
      renderNotices();
      renderSettings();
    } catch (err) { alert(err.message); }
  });
  $("#git-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings({ git_notify: { enabled: e.target.enabled.checked, hours: Number(e.target.hours.value) } });
  });
  $("#ollama-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await saveSettings({ ollama: { url: s.ollama.url, model: e.target.model.value, auto: e.target.auto.checked } })) renderSettings();
  });
  $("#judge-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings({ idle_threshold_min: Number(e.target.idle.value), leave_after_hours: Number(e.target.leave.value) });
  });
  $("#exclude-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings({ excluded_apps: lines(e.target.apps.value),
      browsers: { chrome: e.target.chrome.checked, edge: e.target.edge.checked } });
  });
  $("#cat-add").addEventListener("click", () => {
    const rows = $("#cat-rows");
    rows.insertAdjacentHTML("beforeend", catRowHTML({ name: "", apps: [], domains: [], titles: [] }, rows.children.length, catNames));
  });
  $("#cat-reset").addEventListener("click", async () => {
    if (!confirm("分類のルールを初期値に戻します。自分で変えた分は消えます。よろしいですか？")) return;
    await api.post("/api/categories/reset");
    await loadSettings();
    flash("分類を初期値に戻しました");
    renderSettings();
  });
  $("#cat-rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat-remove]");
    if (b) b.closest(".cat-edit").remove();
  });
  $("#cat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const categories = $$("#cat-rows .cat-edit").map((row) => ({
      name: $("[name=name]", row).value.trim(),
      apps: lines($("[name=apps]", row).value),
      domains: lines($("[name=domains]", row).value),
      titles: lines($("[name=titles]", row).value),
    })).filter((c) => c.name);
    if (await saveSettings({ categories }, "分類を保存しました（過去の記録にも反映されます）")) renderSettings();
  });
}

async function loadCloudState() {
  const c = await api.get("/api/cloud").catch(() => null);
  const el = $("#cloud-state");
  if (!el || !c) return;
  const viewer = c.viewer_url
    ? `ビューアー：<a href="${safeHref(c.viewer_url)}" target="_blank" rel="noopener noreferrer">${esc(c.viewer_url)}</a>` : "";
  if (!c.enabled) {
    el.innerHTML = `<span class="tag">オフ</span> 書き出しを止めています。`;
  } else if (c.last_error) {
    el.innerHTML = `<span class="tag warn">書き出せませんでした</span> ${esc(c.last_error)}`;
  } else if (!c.folder) {
    el.innerHTML = `<span class="tag warn">書き出し先がまだありません</span> iPhone・iPad でビューアーを開いて Microsoft アカウントでサインインすると、OneDrive に専用のフォルダができて、数分で書き出しを始めます。<br>${viewer}`;
  } else {
    el.innerHTML = `<span class="tag">書き出し中</span> ${c.last_export ? `最終更新 ${fmtWhen(c.last_export)}・` : ""}書き出し先 <code>${esc(c.folder)}</code><br>${viewer}`;
  }
}

function catRowHTML(c, i, names) {
  return `<div class="cat-edit">
    <label class="row" style="flex-wrap:nowrap"><i class="sw" style="background:${catColor(c.name, names)}"></i>
      <input type="text" name="name" value="${esc(c.name)}" placeholder="分類名" style="width:100%"></label>
    <textarea name="apps" placeholder="code.exe">${esc(c.apps.join("\n"))}</textarea>
    <textarea name="domains" placeholder="arxiv.org">${esc(c.domains.join("\n"))}</textarea>
    <textarea name="titles" placeholder="Jupyter">${esc(c.titles.join("\n"))}</textarea>
    <button class="icon-btn" type="button" data-cat-remove aria-label="この分類を削除">✕</button>
  </div>`;
}

// ------------------------------------------------------------ ビューアー（サインイン）

function renderSignIn(error) {
  clearTimeout(state.refreshTimer);
  $(".tabs").classList.add("hidden");
  $("#pause").classList.add("hidden");
  $("#status").innerHTML = "";
  $("#notices").innerHTML = "";
  view.innerHTML = `<section class="card signin">
      <h1>LabLog</h1>
      <p class="help">PC の LabLog が OneDrive に保存した記録（入退室・作業時間・日報）を表示します。<br>
        PC で使っている個人の Microsoft アカウントでサインインしてください。</p>
      ${error ? `<div class="notice error"><span class="ico">!</span><div>${esc(error)}</div></div>` : ""}
      <button class="btn btn-primary" id="signin">Microsoft でサインイン</button>
      <p class="help muted">このアプリが読み書きするのは、OneDrive の「アプリ／LabLog」フォルダだけです。</p>
    </section>`;
  $("#signin").addEventListener("click", () => cloud.signIn());
}

function renderFooter() {
  $("#foot").innerHTML = `<span>OneDrive にある要約を表示しています。アプリ・ファイル・閲覧ページなどの詳しい記録は PC で見られます。</span>
    ${cloud.dev ? "" : `<button class="btn btn-sm btn-ghost" id="signout">サインアウト</button>`}`;
  const out = $("#signout");
  if (out) out.addEventListener("click", () => {
    if (!confirm("サインアウトします。この端末に保存してある表示用のデータも消します。")) return;
    cloud.signOut();
    location.reload();
  });
}

// ------------------------------------------------------------ 起動

window.addEventListener("hashchange", route);
(async () => {
  if (cloud) {
    $("[data-tab=settings]").remove();
    $("#pause").textContent = "更新";
    const { signedIn, error } = await cloud.ready();
    if (!signedIn) return renderSignIn(error);
    renderFooter();
  }
  await Promise.all([refreshStatus(), cloud ? null : loadSettings().catch(() => null)]);
  renderNotices();
  await route();
  setInterval(refreshStatus, cloud ? 60000 : 15000);
})();
