// Donini Poster — фоновая часть расширения.
// Связь с программой на этом компьютере + хранение заданий по вкладкам (состояние переживает перезапуск фона).

const DEFAULT_PORT = 8765;

// все изменения состояния — строго по очереди (иначе шаги записи могут потеряться)
let lock = Promise.resolve();
function locked(fn) { const r = lock.then(fn, fn); lock = r.catch(() => {}); return r; }

async function api(path, opts = {}) {
  const { port = DEFAULT_PORT } = await chrome.storage.local.get("port");
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return opts.raw ? r : r.json();
}

// ---------- состояние ----------
async function getState() {
  const { jobs = {}, recs = {} } = await chrome.storage.session.get(["jobs", "recs"]);
  return { jobs, recs };
}
async function saveJobs(jobs) { await chrome.storage.session.set({ jobs }); }
async function saveRecs(recs) { await chrome.storage.session.set({ recs }); }

async function log(text) {
  try { await api("/api/ext/log", { method: "POST", body: { text } }); } catch (e) {}
}

// ---------- фоновый режим: не уводить вас из вашего окна ----------
// Некоторые браузеры (Яндекс) при открытии вкладок/окна выставления выводят его поверх, даже если просим «в фоне».
// Запоминаем окно, в котором вы работаете, и сразу возвращаем его наверх.
async function keepUserFocus(fn) {
  let prev = null;
  try { prev = await chrome.windows.getLastFocused(); } catch (e) {}
  const res = await fn();
  try {
    const pub = await getPub();
    if (pub.background && prev && prev.focused && prev.state !== "minimized") {
      const restore = async () => {
        const now = await chrome.windows.getLastFocused().catch(() => null);
        if (now && now.id !== prev.id) await chrome.windows.update(prev.id, { focused: true });
      };
      await restore();
      setTimeout(() => restore().catch(() => {}), 700); // окно сайта может «выпрыгнуть» с задержкой
    }
  } catch (e) {}
  return res;
}

// ---------- режим публикации и отчёт ----------
async function getPub() {
  const { pubMode = "manual", pubInterval = 90, pubJitter = 20, pubAlways = false, pubBackground = true, pubBatchPause = 15 } =
    await chrome.storage.local.get(["pubMode", "pubInterval", "pubJitter", "pubAlways", "pubBackground", "pubBatchPause"]);
  return { mode: pubMode, interval: pubInterval, jitter: pubJitter, always: pubAlways, background: pubBackground, batchPause: pubBatchPause };
}
// пауза перед следующим товаром (сек) с учётом режима и случайного разброса; 0 — без паузы
function pauseSeconds(pub) {
  if (!(pub.interval > 0) || !(pub.mode === "auto" || pub.always)) return 0;
  const j = Math.max(0, Math.min(90, Number(pub.jitter) || 0)) / 100;
  return Math.max(5, Math.round(pub.interval * (1 + (Math.random() * 2 - 1) * j)));
}
const fmtPause = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
// у авто-режима и у пачки (например, загрузка на свой сайт) — свои отчёты, они работают одновременно
async function getStats(key = "runStats") { const o = await chrome.storage.local.get(key); return o[key] || null; }
async function setStats(st, key = "runStats") { await chrome.storage.local.set({ [key]: st }); }
async function statsReset(title, key = "runStats") { await setStats({ title, started: Date.now(), done: 0, skipped: 0, errors: 0, bySite: {}, products: [] }, key); }
async function statsAdd(kind, job) {
  const key = job && job.batch ? "batchStats" : "runStats";
  const st = await getStats(key);
  if (!st) return;
  st[kind] = (st[kind] || 0) + 1;
  if (kind === "done" && job) {
    const n = job.site && job.site.name || "?";
    st.bySite[n] = (st.bySite[n] || 0) + 1;
    if (job.code && !st.products.includes(job.code)) st.products.push(job.code);
  }
  await setStats(st, key);
}
async function statsReport(reason, key = "runStats") {
  const st = await getStats(key);
  if (!st || st.reported) return;
  st.reported = true; await setStats(st, key);
  const mins = Math.round((Date.now() - st.started) / 60000);
  const sites = Object.entries(st.bySite).map(([k, v]) => `${k}: ${v}`).join(", ");
  await log(`📊 Отчёт (${st.title}${reason ? ", " + reason : ""}): товаров ${st.products.length}, объявлений ${st.done}` +
    (sites ? ` (${sites})` : "") + `, пропущено ${st.skipped}, ошибок ${st.errors}, время ${mins} мин`);
}

// ---------- фото: программа -> вкладка ----------
const photoCache = new Map();
async function loadPhotos(urls) {
  const out = [];
  for (const u of urls) {
    if (!photoCache.has(u)) {
      const r = await api(u, { raw: true });
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      photoCache.set(u, btoa(bin));
      if (photoCache.size > 60) photoCache.delete(photoCache.keys().next().value);
    }
    const name = decodeURIComponent(u.split("path=").pop().split(/[\\/]/).pop() || "foto.jpg");
    out.push({ name: name.endsWith(".jpg") ? name : name + ".jpg", type: "image/jpeg", b64: photoCache.get(u) });
  }
  return out;
}

// ---------- выставление товара ----------
async function startProduct(pid, siteIds, reuseWinId) {
  const job = await api(`/api/ext/job?pid=${encodeURIComponent(pid)}&sites=${encodeURIComponent(siteIds.join(","))}`);
  const { jobs } = await getState();
  let win = null;
  if (reuseWinId) { try { win = await chrome.windows.get(reuseWinId); } catch (e) { win = null; } }
  return keepUserFocus(() => startProductOpen(job, jobs, win));
}
async function startProductOpen(job, jobs, win) {
  let first = true;
  // сайты, которые работают только во вкладке на экране (Njuškalo — дерево категорий), открываем первыми и активными
  const needsFront = (s) => /njuskalo\.hr/i.test((s.site && s.site.start_url) || "") || !!(s.site && s.site.needs_front);
  job.sites.sort((a, b) => needsFront(b) - needsFront(a));
  const bgModeAll = (await getPub()).background;
  // OLX и Njuškalo работают только во вкладке «на экране». В фоновом режиме каждый такой сайт получает
  // своё окно позади (одна вкладка = всегда активная), чтобы они не отнимали экран друг у друга и у остальных.
  const ownWindow = (s) => bgModeAll && /(^|\.)(olx\.(pl|pt|ro|bg|ua|kz|uz)|njuskalo\.hr)(\/|$)/i.test(((s.site && s.site.start_url) || "").replace(/^https?:\/\//, ""));
  const { sideWins = {} } = await chrome.storage.local.get("sideWins");
  for (const s of job.sites) {
    const url = s.site.start_url;
    let tab;
    if (ownWindow(s)) {
      let sw = null;
      if (sideWins[s.site.id]) { try { sw = await chrome.windows.get(sideWins[s.site.id]); } catch (e) { sw = null; } }
      if (sw && win && sw.id === win.id) sw = null;
      if (sw) tab = await chrome.tabs.create({ windowId: sw.id, url, active: true });
      else {
        sw = await chrome.windows.create({ url, focused: false, state: "normal" });
        tab = sw.tabs[0];
        sideWins[s.site.id] = sw.id;
      }
      jobs[tab.id] = {
        pid: job.product.id, code: job.product.code, site: s.site, ad: s.ad, photos: s.photos,
        steps: s.site.steps || [], idx: 0, status: "running", started: Date.now(),
      };
      continue;
    }
    if (!win) {
      // фоновый режим: отдельное окно открывается позади, вас никуда не переключает
      const bgMode = (await getPub()).background;
      win = await chrome.windows.create(bgMode ? { url, focused: false, state: "normal" } : { url, focused: true, state: "maximized" });
      tab = win.tabs[0];
    } else {
      tab = await chrome.tabs.create({ windowId: win.id, url, active: first });
    }
    first = false;
    jobs[tab.id] = {
      pid: job.product.id, code: job.product.code, site: s.site, ad: s.ad, photos: s.photos,
      steps: s.site.steps || [], idx: 0, status: "running", started: Date.now(),
    };
  }
  await chrome.storage.local.set({ sideWins });
  await saveJobs(jobs);
  log(`🧩 Расширение: открываю товар ${job.product.code} на ${job.sites.length} сайтах`);
  return { ok: true, count: job.sites.length, winId: win ? win.id : null };
}

// ---------- АВТО-РЕЖИМ: товары подряд ----------
// Когда по текущему товару все вкладки закончены (опубликовано / «пропустить сайт» / вкладка закрыта),
// расширение само закрывает их и открывает следующий товар из очереди на тех же сайтах.
async function getAuto() { const { auto = null } = await chrome.storage.local.get("auto"); return auto; }
async function setAuto(a) { await chrome.storage.local.set({ auto: a }); }
const FINISHED = ["done", "skipped", "error"];

async function autoStart(pid, sites) {
  const r = await startProduct(pid, sites);
  if (!r || !r.ok) return r;
  await setAuto({ on: true, sites, pid, winId: r.winId, tried: [pid], count: 1, started: Date.now() });
  await statsReset("выставлять подряд");
  log("▶ Авто-режим: товары будут открываться подряд");
  return r;
}
async function autoStop(reason) {
  const a = await getAuto();
  if (a && a.on) { a.on = false; await setAuto(a); await log(`■ Авто-режим остановлен${reason ? ": " + reason : ""} (открыто товаров: ${a.count || 0})`); await statsReport(reason); }
  return { ok: true };
}
let autoTimer = null;
// Chrome «усыпляет» фон расширения примерно через 30 сек без дела — обычный таймер паузы при этом пропадает.
// Поэтому длинные паузы ставим через будильник chrome.alarms: он разбудит расширение в нужный момент.
function scheduleAutoCheck(ms = 2500) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => locked(autoCheck), ms);
  if (ms > 15000) chrome.alarms.create("autoCheck", { when: Date.now() + ms });
}
// ---------- ПАКЕТНЫЙ РЕЖИМ: один сайт, товары одной линии подряд в ОДНОЙ вкладке ----------
// Например: «Сумки → Kleinanzeigen → 10 шт.». Товар заполнился → вы опубликовали (или пропустили) →
// в этой же вкладке сам открывается следующий товар. Вы всё время на одном сайте.
async function getBatch() { const { batch = null } = await chrome.storage.local.get("batch"); return batch; }
async function setBatch(b) { await chrome.storage.local.set({ batch: b }); }

async function batchPickNext(b) {
  const st = await api("/api/ext/state");
  return (st.products || []).find((p) => p.line === b.line && !(b.tried || []).includes(p.id) && p.sites.some((x) => x.id === b.site)) || null;
}
async function batchOpen(b, p, tabId) {
  const job = await api(`/api/ext/job?pid=${encodeURIComponent(p.id)}&sites=${encodeURIComponent(b.site)}`);
  const s = job.sites[0];
  const { jobs } = await getState();
  jobs[tabId] = {
    pid: job.product.id, code: job.product.code, site: s.site, ad: s.ad, photos: s.photos,
    steps: s.site.steps || [], idx: 0, status: "running", started: Date.now(), batch: true,
  };
  await saveJobs(jobs);
  await keepUserFocus(() => chrome.tabs.update(tabId, { url: s.site.start_url, active: true }));
  b.tried = [...(b.tried || []), p.id].slice(-3000);
  b.opened = (b.opened || 0) + 1;
  await setBatch(b);
  log(`📦 Пачка ${b.siteName}: открыт товар ${job.product.code} (выставлено ${b.done || 0} из ${b.target})`);
}
async function batchStart(line, site, target) {
  // пачка (например, загрузка на свой сайт) работает ОДНОВРЕМЕННО с авто-режимом, в своём окне
  const st = await api("/api/ext/state");
  const siteInfo = (st.sites || []).find((x) => x.id === site);
  const lineInfo = (st.lines || []).find((x) => x.id === line);
  const b = { on: true, line, site, target: Math.max(1, Number(target) || 10), opened: 0, done: 0, skipped: 0, tried: [],
              siteName: siteInfo ? siteInfo.name : site, lineName: lineInfo ? lineInfo.name : line, started: Date.now() };
  const p = await batchPickNext(b);
  if (!p) return { ok: false, error: "Для этой линии нет товаров, которые ещё не выставлены на этом сайте" };
  const bgMode = (await getPub()).background;
  const win = await keepUserFocus(() => chrome.windows.create(bgMode ? { url: "about:blank", focused: false, state: "normal" } : { url: "about:blank", focused: true, state: "maximized" }));
  b.tabId = win.tabs[0].id; b.winId = win.id;
  await setBatch(b);
  log(`📦 Пачка: ${b.lineName} → ${b.siteName}, до ${b.target} шт.`);
  await statsReset(`пачка ${b.lineName} → ${b.siteName}`, "batchStats");
  await batchOpen(b, p, b.tabId);
  return { ok: true };
}
async function batchStop(reason) {
  const b = await getBatch();
  if (b && b.on) {
    b.on = false; await setBatch(b);
    await log(`■ Пачка ${b.siteName} закончена${reason ? ": " + reason : ""} — выставлено ${b.done || 0}, пропущено ${b.skipped || 0}`);
    await statsReport(reason, "batchStats");
  }
  return { ok: true };
}
let batchTimer = null;
function scheduleBatchNext(tabId, ms = 3000) {
  clearTimeout(batchTimer);
  batchTimer = setTimeout(() => locked(() => batchNext(tabId)), ms);
  if (ms > 15000) chrome.alarms.create("batchNext:" + tabId, { when: Date.now() + ms });
}
chrome.alarms.onAlarm.addListener((al) => {
  if (al.name === "autoCheck") locked(autoCheck);
  else if (al.name.startsWith("batchNext:")) { const t = Number(al.name.split(":")[1]); locked(() => batchNext(t)); }
});
// расширение проснулось (после сна или перезапуска Chrome) — продолжаем начатое
(async () => {
  try {
    const a = await getAuto();
    if (a && a.on) scheduleAutoCheck(a.waitUntil && a.waitUntil > Date.now() ? a.waitUntil - Date.now() + 200 : 3000);
    const b = await getBatch();
    if (b && b.on && b.tabId) scheduleBatchNext(b.tabId, b.waitUntil && b.waitUntil > Date.now() ? b.waitUntil - Date.now() + 200 : 3000);
  } catch (e) {}
})();
async function batchNext(tabId) {
  const b = await getBatch();
  if (!b || !b.on || b.tabId !== tabId) return;
  const { jobs } = await getState();
  const j = jobs[tabId];
  if (j && !FINISHED.includes(j.status)) return; // ещё не закончен
  if (j && !j.counted) {
    if (j.status === "done") b.done = (b.done || 0) + 1; else b.skipped = (b.skipped || 0) + 1;
    j.counted = true; await saveJobs(jobs); await setBatch(b);
    // уведомление по каждому товару пачки (уходит в Telegram)
    if (j.status === "done") log(`✅ Товар ${j.code} загружен на ${b.siteName} (${b.done} из ${b.target})`);
    else log(`⚠️ ${b.siteName}: товар ${j.code} не загружен — пропущен (${b.done} из ${b.target}, пропущено ${b.skipped})`);
  }
  if ((b.done || 0) >= b.target) { await batchStop("норма выполнена"); return; }
  let p = null;
  try { p = await batchPickNext(b); } catch (e) { return; }
  if (!p) { await batchStop("товары этой линии для сайта закончились"); return; }
  const pub = await getPub();
  if (!b.waitUntil) {
    // у пачки своя пауза (настройка «Пачка: пауза между товарами»)
    const sec = Math.max(0, Number(pub.batchPause) || 0);
    const spent = b.startedAt ? Math.round((Date.now() - b.startedAt) / 1000) : 0;
    const left = sec; // полная пауза ПОСЛЕ товара (как задано в настройке «интервал»)
    if (left) { b.waitUntil = Date.now() + left * 1000; await setBatch(b); }
  }
  if (b.waitUntil) {
    if (Date.now() < b.waitUntil) { scheduleBatchNext(tabId, b.waitUntil - Date.now() + 200); return; }
    b.waitUntil = 0; await setBatch(b);
  }
  b.startedAt = Date.now(); await setBatch(b);
  await batchOpen(b, p, tabId);
}

async function autoCheck() {
  const a = await getAuto();
  if (!a || !a.on) return;
  const { jobs } = await getState();
  const cur = Object.entries(jobs).filter(([, j]) => j.pid === a.pid);
  if (cur.some(([, j]) => !FINISHED.includes(j.status))) return; // ещё не всё сделано
  // пауза между товарами (чтобы сайты не считали это роботом)
  // пауза между товарами: отсчитывается после того, как товар выставлен на всех сайтах
  if (a.waitFor !== a.pid) {
    const sec = pauseSeconds(await getPub());
    const spent = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
    const left = sec; // полная пауза ПОСЛЕ товара (как задано в настройке «интервал»)
    a.waitFor = a.pid; a.waitUntil = left ? Date.now() + left * 1000 : 0; await setAuto(a);
    if (left) log(`⏳ Пауза ${fmtPause(left)} перед следующим товаром`);
  }
  if (a.waitUntil && Date.now() < a.waitUntil) { scheduleAutoCheck(a.waitUntil - Date.now() + 200); return; }
  // следующий товар: первый в очереди, который в этом заходе ещё не открывали
  let st;
  try { st = await api("/api/ext/state"); } catch (e) { return; }
  // сначала товары, которые ждут ВСЕ выбранные сайты; недоделанные (уже выставлены на части сайтов) — в конце
  let next = null, nextSites = [];
  for (const p of st.products || []) {
    if ((a.tried || []).includes(p.id)) continue;
    const ids = p.sites.map((x) => x.id).filter((id) => !a.sites || !a.sites.length || a.sites.includes(id));
    if (ids.length > nextSites.length) { next = p; nextSites = ids; }
    if (a.sites && ids.length >= a.sites.length) break; // полный товар — берём сразу
  }
  const oldTabs = cur.map(([tid]) => Number(tid));
  if (!next) {
    await autoStop("очередь закончилась");
    return;
  }
  // сайты, где этот товар уже выставлен раньше, не открываем повторно (иначе будут дубли объявлений)
  const already = (a.sites || []).filter((id) => !nextSites.includes(id));
  if (already.length) {
    const nm = (id) => ((st.sites || []).find((x) => x.id === id) || {}).name || id;
    log(`ℹ️ Товар ${next.code} уже выставлен на: ${already.map(nm).join(", ")} — открываю только оставшиеся сайты (${nextSites.length})`);
  }
  a.pid = next.id; a.tried = [...(a.tried || []), next.id].slice(-500); a.count = (a.count || 0) + 1;
  a.startedAt = Date.now();
  await setAuto(a);
  const r = await startProduct(next.id, nextSites, a.winId);
  if (r && r.winId) { a.winId = r.winId; await setAuto(a); }
  // старые вкладки закрываем после открытия новых (окно не закроется)
  for (const t of oldTabs) { try { await chrome.tabs.remove(t); } catch (e) {} }
}

// Итог по товару (уходит в Telegram): как только по нему закончены все открытые сайты —
// и в авто-режиме, и когда товар открыт вручную одной кнопкой
async function productSummary(pid) {
  if (!pid) return;
  const { jobs } = await getState();
  const all = Object.values(jobs).filter((j) => j.pid === pid && !j.batch);
  if (!all.length || all.some((j) => !FINISHED.includes(j.status)) || all.some((j) => j.summarized)) return;
  all.forEach((j) => { j.summarized = true; });
  await saveJobs(jobs);
  const ok = all.filter((j) => j.status === "done");
  const bad = all.filter((j) => j.status !== "done").map((j) => j.site && j.site.name).filter(Boolean);
  const started = Math.min(...all.map((j) => j.started || Date.now()));
  const spent = Math.max(0, Math.round((Date.now() - started) / 1000));
  await log(`✅ Товар ${all[0].code || ""} выставлен: ${ok.length} из ${all.length} сайтов за ${fmtPause(spent)}` + (bad.length ? ` (не вышло: ${bad.join(", ")})` : ""));
}

async function markDone(tabId, url) {
  const { jobs } = await getState();
  const j = jobs[tabId];
  if (!j || j.status === "done") return;
  try {
    await api("/api/helper/done", { method: "POST", body: { pid: j.pid, site: j.site.id, url: url || "" } });
    j.status = "done";
    await statsAdd("done", j);
  } catch (e) {
    j.status = "error";
    j.error = e.message;
  }
  await saveJobs(jobs);
  try { await chrome.tabs.sendMessage(tabId, { type: "jobUpdated" }); } catch (e) {}
  await productSummary(j.pid);
  scheduleAutoCheck(4000); // дать увидеть «✅ выставлен» перед переходом к следующему товару
  scheduleBatchNext(tabId, 3000);
}

// после клика «Опубликовать»: ждём, что сайт перейдёт на другую страницу
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  locked(async () => {
  const { jobs } = await getState();
  const j = jobs[tabId];
  if (j && j.status === "published_wait" && info.url !== j.publishUrl) {
    await markDone(tabId, info.url);
  }
  });
});
chrome.tabs.onRemoved.addListener((tabId) => locked(async () => {
  const { jobs, recs } = await getState();
  if (jobs[tabId]) {
    if (jobs[tabId].status === "published_wait") await markDone(tabId, jobs[tabId].publishUrl);
    const { jobs: j2 } = await getState();
    delete j2[tabId];
    await saveJobs(j2);
    scheduleAutoCheck();
  }
  const b = await getBatch();
  if (b && b.on && b.tabId === tabId) await batchStop("вкладку закрыли");
  if (recs[tabId]) { delete recs[tabId]; await saveRecs(recs); }
}));

// ---------- запись сценария ----------
async function startRecording(siteId, line) {
  const sample = await api(`/api/ext/sample?site=${encodeURIComponent(siteId)}&line=${encodeURIComponent(line || "default")}`);
  // окно программы — отдельное приложение, поэтому окно Chrome для записи выводим на передний план
  let tab;
  try { tab = await chrome.tabs.create({ url: sample.site.start_url, active: true }); }
  catch (e) { const w = await chrome.windows.create({ url: sample.site.start_url, focused: true, state: "maximized" }); tab = w.tabs[0]; }
  try { await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }); } catch (e) {}
  const { recs } = await getState();
  recs[tab.id] = {
    siteId, line: line || "default", siteName: sample.site.name + (line && line !== "default" ? ` · линия «${sample.line_name || line}»` : ""), ad: sample.ad, photos: sample.photos,
    steps: [{ action: "goto", url: sample.site.start_url, label: "открыть сайт" }],
    focus: null, varFields: [], lastClickAt: 0,
  };
  await saveRecs(recs);
  log(`🎥 Расширение: запись сценария ${sample.site.name}`);
  return { ok: true };
}

const PUBLISH_WORDS = /zveřejn|opublikuj|veröffentlich|anzeige aufgeben|plaats (je )?advertentie|plaatsen|predaj oglas|objavi oglas|подать объявление|опубликовать|feladás|hirdetés feladása|publicar|publică|publish|dodaj ogłoszenie/i;

async function recAddStep(tabId, step, frameUrl) {
  const { recs } = await getState();
  const r = recs[tabId];
  if (!r) return 0;
  if (frameUrl) step.frame = frameUrl;
  // ручной ввод в поле, куда уже вставлен текст товара кнопкой панели, не записываем
  if (step.action === "fill" && !String(step.value || "").startsWith("{") && r.varFields.includes((step.selectors || [])[0])) {
    // вы допечатали пробелы после названия — запоминаем это для сайта
    const v = String(step.value || ""), t = String(r.ad.title || "").trimEnd();
    if (t && v.trimEnd() === t) {
      const n = v.length - v.trimEnd().length;
      if (n !== r.titleSpaces) {
        r.titleSpaces = n;
        await saveRecs(recs);
        try { await api(`/api/site/${encodeURIComponent(r.siteId)}`, { method: "POST", body: { title_spaces: n } }); } catch (e) {}
        log(`✍️ ${r.siteName}: после названия будет пробелов: ${n}`);
      }
    }
    return r.steps.length;
  }
  if (step.action === "click") r.lastClickAt = Date.now();
  r.steps.push(step);
  await saveRecs(recs);
  return r.steps.length;
}

async function finishRecording(tabId) {
  const { recs } = await getState();
  const r = recs[tabId];
  if (!r) return { ok: false };
  let res = { ok: true, steps: r.steps.length };
  if (r.steps.length > 1) {
    res = await api("/api/ext/scenario", { method: "POST", body: { site: r.siteId, line: r.line, steps: r.steps } });
  }
  delete recs[tabId];
  await saveRecs(recs);
  return res;
}

// ---------- шаг внутри фрейма (редактор описания и т.п.) ----------
async function frameIdFor(tabId, frameUrl) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const base = (u) => (u || "").split("#")[0].split("?")[0];
  let origin = ""; try { origin = new URL(frameUrl).origin; } catch (e) {}
  const f = frames.find((x) => x.frameId !== 0 && base(x.url) === base(frameUrl))
         || frames.find((x) => x.frameId !== 0 && base(x.url).startsWith(base(frameUrl).replace(/[^/]*$/, "")))
         || (origin && origin !== "null" ? frames.find((x) => x.frameId !== 0 && x.url.startsWith(origin)) : null);
  return f ? f.frameId : null;
}

// вставка описания через API редактора (TinyMCE / CKEditor) — вне общей очереди сообщений и с ограничением по времени,
// чтобы «зависший» рекламный фрейм не останавливал расширение
async function setRichEditor(tabId, msg) {
        // вставка описания через API редактора на самой странице (TinyMCE, CKEditor 4/5)
        let res = [];
        try {
          res = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            injectImmediately: true,
            world: "MAIN",
            args: [msg.value],
            func: (text) => {
              const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              const html = String(text).split(/\n{2,}/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
              const size = (el) => { if (!el) return 0; const r = el.getBoundingClientRect(); return r.width * r.height; };
              try {
                const t = window.tinymce;
                if (t) {
                  const eds = (t.get ? [].concat(t.get() || []) : []).concat(t.editors ? Array.from(t.editors) : []).filter(Boolean);
                  const uniq = Array.from(new Set(eds));
                  uniq.sort((a, b) => size(b.getContainer && b.getContainer()) - size(a.getContainer && a.getContainer()));
                  const ed = uniq.find((e) => size(e.getContainer && e.getContainer()) > 0) || t.activeEditor || uniq[0];
                  if (ed) {
                    ed.setContent(html);
                    try { ed.undoManager && ed.undoManager.add(); } catch (e) {}
                    try { ed.setDirty && ed.setDirty(true); } catch (e) {}
                    try { ed.fire ? (ed.fire("change"), ed.fire("input"), ed.fire("keyup")) : ed.dispatch && (ed.dispatch("change"), ed.dispatch("input")); } catch (e) {}
                    try { ed.save(); } catch (e) {}
                    try { const ta = ed.getElement && ed.getElement(); if (ta) { ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new Event("change", { bubbles: true })); } } catch (e) {}
                    if ((ed.getContent({ format: "text" }) || "").trim()) return "tinymce";
                  }
                }
              } catch (e) {}
              try {
                const C = window.CKEDITOR;
                if (C && C.instances) {
                  const list = Object.values(C.instances);
                  if (list.length) { const ed = list[0]; ed.setData(html); try { ed.updateElement(); ed.fire("change"); } catch (e) {} return "ckeditor4"; }
                }
              } catch (e) {}
              try {
                const el = document.querySelector(".ck-editor__editable");
                if (el && el.ckeditorInstance) { el.ckeditorInstance.setData(html); return "ckeditor5"; }
              } catch (e) {}
              return null;
            },
          });
        } catch (e) { return { ok: false, error: String(e) }; }
        const hit = (res || []).find((x) => x && x.result);
        return { ok: !!hit, editor: hit ? hit.result : null };
      }
// Поля цены с «маской» (AutoNumeric на vendora.gr: «119» → «119,00»): обычная вставка текста ломает
// формат или не доходит до сайта. Ставим число через саму маску на странице.
async function setMaskedNumber(tabId, frameId, msg) {
  const res = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    args: [msg.value],
    func: (val) => {
      const el = document.querySelector("[data-donini-mask]");
      if (!el) return { ok: false };
      const num = Number(String(val).replace(/\s/g, "").replace(",", "."));
      if (!isFinite(num)) return { ok: false };
      let an = null;
      for (let x = el; x && !an; x = x.parentElement) { const vm = x.__vue__; if (vm && vm.anElement && vm.anElement.set) an = vm.anElement; }
      if (!an && window.AutoNumeric && window.AutoNumeric.getAutoNumericElement) an = window.AutoNumeric.getAutoNumericElement(el);
      if (!an) return { ok: false };
      an.set(num);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, shown: el.value };
    },
  });
  return (res && res[0] && res[0].result) || { ok: false };
}

async function setRichEditorSafe(tabId, msg) {
  return Promise.race([setRichEditor(tabId, msg).catch((e) => ({ ok: false, error: String(e) })),
                       new Promise((r) => setTimeout(() => r({ ok: false, error: "timeout" }), 6000))]);
}

// ---------- СИНХРОНИЗАЦИЯ С DONINI MANAGER ПО КНОПКЕ ----------
// Ищем открытый Donini Manager во всех вкладках Chrome, читаем его шаблоны и правки карточек
// (свежим скриптом — работает и после обновления расширения) и отправляем в программу.
async function syncFromManagerNow() {
  const found = [];
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) {}
  // все вкладки опрашиваем одновременно, каждую не дольше 3 секунд
  await Promise.all(tabs.filter((t) => t.url && /^https?:/.test(t.url)).map(async (t) => {
    let res = [];
    try {
      res = await Promise.race([chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: true },
        injectImmediately: true,
        func: () => {
          try {
            const ls = window.localStorage;
            const ct = ls.getItem("plt_customTypes"), ov = ls.getItem("plt_overrides_v1"), pt = ls.getItem("plt_productType");
            if (ct === null && ov === null && pt === null) return null;
            return { ct, ov };
          } catch (e) { return null; }
        },
      }), new Promise((r) => setTimeout(() => r([]), 3000))]);
    } catch (e) { return; }
    for (const r of res || []) if (r && r.result) found.push(r.result);
  }));
  if (!found.length) return { ok: false, error: "Donini Manager не открыт в этом Chrome. Откройте его во вкладке и нажмите ещё раз." };
  // если Manager открыт в нескольких вкладках — берём тот, где больше шаблонов
  found.sort((a, b) => (b.ct || "").length - (a.ct || "").length);
  let customTypes = [], o = {};
  try { customTypes = JSON.parse(found[0].ct || "[]") || []; } catch (e) {}
  try { o = JSON.parse(found[0].ov || "{}") || {}; } catch (e) {}
  const r = await api("/api/templates/sync", { method: "POST", body: { customTypes, titleOverrides: o.titleOverrides || {}, bodyOverrides: o.bodyOverrides || {}, force: true } });
  return { ok: true, templates: customTypes.length, titles: Object.keys(o.titleOverrides || {}).length,
           bodies: Object.keys(o.bodyOverrides || {}).length, changed: r && r.changed };
}

// ---------- сообщения ----------
const onMsg = (msg, sender, reply) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  const frameId = sender.frameId || 0;
  const frameUrl = frameId ? sender.url : null;
  if (msg.type === "setRichEditor") { setRichEditorSafe(tabId, msg).then(reply); return true; }
  if (msg.type === "setMasked") { setMaskedNumber(tabId, frameId, msg).then(reply, () => reply({ ok: false })); return true; }
  // скачивание каталога szwego (微商相册): страница собирает товары, программа скачивает фото в папки
  if (msg.type === "szwegoLines") {
    api("/api/ext/state").then((s) => reply({ ok: true, lines: (s.lines || []).map((l) => ({ id: l.id, name: l.name })) }),
      (e) => reply({ ok: false, error: "Программа Donini Poster не запущена (" + e.message + ")" }));
    return true;
  }
  if (msg.type === "szwegoItem") {
    api("/api/szwego/item", { method: "POST", body: msg.body }).then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "szwegoShop") {
    api("/api/szwego/shop", { method: "POST", body: msg.body }).then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "szwegoOpen") {
    api("/api/szwego/open", { method: "POST", body: msg.body || {} }).then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "pubGet") { getPub().then(reply); return true; }
  if (msg.type === "pubSet") {
    (async () => {
      const cur = await getPub();
      const mode = msg.mode === "auto" || msg.mode === "manual" ? msg.mode : cur.mode;
      const interval = msg.interval != null ? Math.max(0, Math.min(3600, Number(msg.interval) || 0)) : cur.interval;
      const jitter = msg.jitter != null ? Math.max(0, Math.min(90, Number(msg.jitter) || 0)) : cur.jitter;
      const always = msg.always != null ? !!msg.always : cur.always;
      const background = msg.background != null ? !!msg.background : cur.background;
      const batchPause = msg.batchPause != null ? Math.max(0, Math.min(3600, Number(msg.batchPause) || 0)) : cur.batchPause;
      await chrome.storage.local.set({ pubMode: mode, pubInterval: interval, pubJitter: jitter, pubAlways: always, pubBackground: background, pubBatchPause: batchPause });
      if (batchPause !== cur.batchPause) log(`⏱ Пачка: пауза между товарами ${batchPause} сек`);
      if (background !== cur.background) log(background ? "🪟 Фоновый режим: выставление идёт в отдельном окне, вас на вкладки не переключает" : "🪟 Фоновый режим выключен: окно выставления открывается поверх");
      if (interval !== cur.interval || jitter !== cur.jitter || always !== cur.always)
        log(`⏱ Интервал между товарами: ${fmtPause(interval)} ±${jitter}%${always ? " (в обоих режимах)" : " (в режиме «без меня»)"}`);
      if (mode !== cur.mode) log(mode === "auto" ? "🤖 Режим «без меня»: программа сама публикует объявления" : "🙋 Режим «с моим участием»: «Опубликовать» нажимаете вы");
      reply(await getPub());
    })();
    return true;
  }
  if (msg.type === "managerSyncNow") {
    syncFromManagerNow().then(reply, (e) => reply({ ok: false, error: "Программа не отвечает: " + e.message }));
    return true;
  }
  locked(async () => {
    const { jobs, recs } = await getState();
    switch (msg.type) {
      // --- popup ---
      case "popupState": return api("/api/ext/state");
      case "start": await autoStop(); return startProduct(msg.pid, msg.sites);
      case "autoStart": return autoStart(msg.pid, msg.sites);
      case "batchStart": return batchStart(msg.line, msg.site, msg.target);
      case "batchStop": return batchStop("вручную");
      case "batchState": { const b = await getBatch(); return { batch: b && b.on ? b : null }; }
      // ---- свой сайт doninisklep.com (загрузка идёт в программе, без браузера) ----
      case "wooState": try { return await api("/api/woo/config"); } catch (e) { return null; }
      case "wooRun": try { return await api("/api/woo/run", { method: "POST", body: { on: !!msg.on } }); } catch (e) { return { ok: false, error: e.message }; }
      case "wooFolder": {
        try { const c = await api("/api/config"); const l = (c.lines || []).find((x) => x.id === "site"); await api("/api/open_folder", { method: "POST", body: { path: l ? l.folder : "" } }); } catch (e) {}
        return { ok: true };
      }
      case "autoStop": return autoStop("вручную");
      case "autoState": {
        const a = await getAuto();
        const open = Array.from(new Set(Object.values(jobs).filter((j) => !FINISHED.includes(j.status)).map((j) => j.pid)));
        return { auto: a && a.on ? a : null, openPids: open };
      }
      case "record": return startRecording(msg.site, msg.line);
      case "setPort": await chrome.storage.local.set({ port: msg.port }); return { ok: true };
      case "managerSyncNow":
        try { return await syncFromManagerNow(); } catch (e) { return { ok: false, error: "Программа не отвечает: " + e.message }; }
      case "managerSync":
        try {
          return await api("/api/templates/sync", { method: "POST", body: { customTypes: msg.customTypes, titleOverrides: msg.titleOverrides, bodyOverrides: msg.bodyOverrides } });
        } catch (e) { return { ok: false, error: String(e) }; }

      // --- вкладка ---
      case "hello": {
        if (frameId !== 0) return { rec: !!recs[tabId], job: null };
        return { job: jobs[tabId] || null, rec: recs[tabId] ? { siteName: recs[tabId].siteName, count: recs[tabId].steps.length } : null };
      }
      case "setIdx": if (jobs[tabId]) { jobs[tabId].idx = msg.idx; await saveJobs(jobs); } return { ok: true };
      case "photos": return loadPhotos(msg.urls);
      case "focusMe":
        try {
          // вкладку делаем активной только в её окне; поверх всего окно выводим, лишь если фоновый режим выключен
          const t = await keepUserFocus(() => chrome.tabs.update(tabId, { active: true }));
          if (t && t.windowId != null && !(await getPub()).background) await chrome.windows.update(t.windowId, { focused: true });
        } catch (e) {}
        return { ok: true };
      case "publishClicked":
        if (jobs[tabId]) { jobs[tabId].status = "published_wait"; jobs[tabId].publishUrl = msg.url; await saveJobs(jobs); }
        // если сайт не перешёл на другую страницу — через 20 сек всё равно считаем выставленным
        setTimeout(() => locked(async () => {
          const { jobs: j2 } = await getState();
          if (j2[tabId] && j2[tabId].status === "published_wait") {
            // предупреждаем, только если на странице правда видна ошибка или капча (а не просто сайт остался на месте)
            let chk = null;
            try { chk = await chrome.tabs.sendMessage(tabId, { type: "publishCheck" }, { frameId: 0 }); } catch (e) {}
            const errs = chk && chk.errors || [];
            if (msg.auto && errs.length) log(`⚠️ ${j2[tabId].site.name}: товар ${j2[tabId].code} — после «Опубликовать» на странице: ${errs.join("; ").slice(0, 160)}. Отмечен как выставленный — проверьте на сайте.`);
            await markDone(tabId, msg.url);
          }
        }), msg.auto ? 30000 : 20000);
        return { ok: true };
      case "manualDone": await markDone(tabId, msg.url); return { ok: true };
      case "skipSite":
        if (jobs[tabId] && !FINISHED.includes(jobs[tabId].status)) await statsAdd("skipped", jobs[tabId]);
        if (jobs[tabId]) {
          // keep: пропуск из-за ошибки в режиме «без меня» — в программе сайт остаётся «ждёт», чтобы выставить потом
          if (!msg.keep) { try { await api("/api/helper/skip", { method: "POST", body: { pid: jobs[tabId].pid, site: jobs[tabId].site.id } }); } catch (e) {} }
          jobs[tabId].status = "skipped"; await saveJobs(jobs);
          await productSummary(jobs[tabId].pid);
        }
        scheduleAutoCheck();
        scheduleBatchNext(tabId, 1500);
        return { ok: true };
      case "stepTime":
        log(`⏱ ${jobs[tabId] ? jobs[tabId].site.name : ""}: ${msg.text}`); return { ok: true };
      case "stepError":
        if (!msg.soft) await statsAdd("errors", jobs[tabId]);
        log(`⚠️ ${jobs[tabId] ? jobs[tabId].site.name : ""}: ${msg.text}`); return { ok: true };
      case "fillBiggestAnyFrame": {
        const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
        for (const f of frames) {
          if (f.frameId === 0) continue;
          try {
            const r = await chrome.tabs.sendMessage(tabId, { type: "fillBiggest", value: msg.value }, { frameId: f.frameId });
            if (r && r.ok) return { ok: true };
          } catch (e) {}
        }
        return { ok: false };
      }
      case "frameStep": {
        const fid = await frameIdFor(tabId, msg.step.frame);
        if (fid == null) return { ok: false, error: "фрейм не найден" };
        return chrome.tabs.sendMessage(tabId, { type: "doFrameStep", step: msg.step, value: msg.value }, { frameId: fid });
      }

      // --- запись ---
      case "recStep": return recAddStep(tabId, msg.step, frameUrl);
      case "recFocus": if (recs[tabId]) { recs[tabId].focus = { frameId, frameUrl, selectors: msg.selectors }; await saveRecs(recs); } return { ok: true };
      case "recFill": {
        const r = recs[tabId];
        if (!r) return { ok: false, msg: "запись не идёт" };
        const names = { title: "Название", body: "Описание", price: "Цена", size: "Размер", code: "Код" };
        const value = String(r.ad[msg.v] ?? "");
        if (!value) return { ok: false, msg: `«${names[msg.v]}» пустое — проверьте шаблон/цену в программе («Линии товара»).` };
        // спрашиваем все фреймы страницы, где СЕЙЧАС курсор (а не где он был раньше)
        try {
          const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
          for (const f of frames) {
            let info = null;
            try { info = await chrome.tabs.sendMessage(tabId, { type: "focusInfo" }, { frameId: f.frameId }); } catch (e) {}
            if (info && info.focused && info.field) {
              r.focus = { frameId: f.frameId, frameUrl: f.frameId ? f.url : null, selectors: info.selectors, frameSel: f.frameId ? info.frameSel : null };
              break;
            }
          }
        } catch (e) {}
        if (!r.focus) return { ok: false, msg: "Сначала кликните в поле на сайте (чтобы там мигал курсор), потом нажмите кнопку." };
        let res = null;
        try { res = await chrome.tabs.sendMessage(tabId, { type: "insertFocused", value }, { frameId: r.focus.frameId }); } catch (e) {}
        if ((!res || !res.ok) && r.focus.frameId !== 0) {
          try { res = await chrome.tabs.sendMessage(tabId, { type: "insertFocused", value }, { frameId: 0 }); } catch (e) {}
        }
        if (!res || !res.ok) return { ok: false, msg: "Не получилось вставить. Кликните прямо в поле (чтобы мигал курсор) и сразу нажмите кнопку. Если не выходит — вставьте текст сами (Ctrl+V) и нажмите «Пропустить» при выставлении." };
        const sels = r.focus.selectors || [];
        if (sels[0] && !r.varFields.includes(sels[0])) r.varFields.push(sels[0]);
        await saveRecs(recs);
        const step = { action: "fill", selectors: sels, value: `{${msg.v}}`, label: names[msg.v] };
        if (r.focus.frameSel) step.frameSel = r.focus.frameSel;
        const n = await recAddStep(tabId, step, r.focus.frameUrl);
        return { ok: true, count: n };
      }
      case "recUpload": {
        const r = recs[tabId];
        if (!r) return { ok: false };
        // клик по кнопке, открывшей выбор файлов, превращаем в шаг «фото»
        let selectors = msg.selectors;
        const last = r.steps[r.steps.length - 1];
        // …но не кнопку «Далее/Dalej/Weiter…» — это отдельный шаг, без него форма не откроется
        const NAV = /^(dalej|další|pokračovat|weiter|next|continue|continuar|seguinte|siguiente|volgende|doorgaan|tovább|nastavi|далее|продолжить)\b/i;
        const lastTxt = last ? String(last.label || "") : "";
        if (last && last.action === "click" && Date.now() - r.lastClickAt < 2500 && !NAV.test(lastTxt.trim())) { r.steps.pop(); selectors = last.selectors.concat(selectors); }
        r.steps.push({ action: "upload", selectors, multiple: msg.multiple, label: "фото", ...(frameUrl ? { frame: frameUrl } : {}) });
        await saveRecs(recs);
        return { ok: true, count: r.steps.length, photos: await loadPhotos(msg.multiple ? r.photos : r.photos.slice(0, 1)) };
      }
      case "recUndo": if (recs[tabId] && recs[tabId].steps.length > 1) { recs[tabId].steps.pop(); await saveRecs(recs); } return { count: recs[tabId] ? recs[tabId].steps.length : 0 };
      case "recDone": {
        const res = await finishRecording(tabId);
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
        return res;
      }
      case "recIsPublish": return { yes: PUBLISH_WORDS.test(msg.label || "") };
    }
    return { ok: false, error: "unknown" };
  }).then(reply, (e) => reply({ ok: false, error: e.message }));
  return true;
};
chrome.runtime.onMessage.addListener(onMsg);

// ---------- мост с окном программы Donini Poster ----------
// Окно программы (отдельное приложение, не вкладка Chrome) управляет расширением через программу:
// расширение постоянно спрашивает у программы «есть команда?» и отвечает результатом.
const BRIDGE_ALLOWED = ["pubGet", "pubSet", "popupState", "autoState", "batchState", "autoStart", "autoStop",
  "batchStart", "batchStop", "start", "record", "managerSyncNow", "status", "openTab", "szwegoAll"];
// открыть сайт в Chrome и показать окно (кнопки «Открыть …» в окне программы)
async function openTabFront(url) {
  let tab;
  try { tab = await chrome.tabs.create({ url, active: true }); }
  catch (e) { const w = await chrome.windows.create({ url, focused: true, state: "maximized" }); tab = w.tabs[0]; }
  try { await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }); } catch (e) {}
  return { ok: true };
}
// раздел альбома 微商相册 целиком в очередь: открываем альбом в фоновом окне и запускаем там скачивание
async function szwegoAll(msg) {
  const url = msg.url + (msg.tag ? (msg.url.includes("?") ? "&" : "?") + "tagId=" + encodeURIComponent(msg.tag) : "");
  const w = await chrome.windows.create({ url, focused: false, state: "normal", width: 1100, height: 800 });
  const tabId = w.tabs[0].id;
  await new Promise((ok) => {
    const t = setTimeout(done, 40000);
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(h); ok(); }
    function h(id, info) { if (id === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(h);
  });
  await new Promise((ok) => setTimeout(ok, 4000)); // страница альбома дорисовывается
  log(`⬇ WeChat: скачиваю «${msg.tagName || "весь альбом"}» в очередь…`);
  let r = null;
  for (let i = 0; i < 5 && !r; i++) {
    try { r = await chrome.tabs.sendMessage(tabId, { type: "szwegoRunAll", line: msg.line, tag: msg.tag || "", tagName: msg.tagName || "", only_new: msg.only_new !== false }); }
    catch (e) { await new Promise((ok) => setTimeout(ok, 3000)); }
  }
  try { await chrome.windows.remove(w.id); } catch (e) {}
  if (!r) r = { ok: false, error: "страница альбома не ответила — откройте 微商相册 в Chrome и войдите в аккаунт" };
  log(r.ok ? `⬇ WeChat «${r.tagName}»: в очередь ${r.done}, уже были ${r.skipped}, без размера ${r.noSize}${r.errors ? `, ошибок ${r.errors}` : ""}`
    : `⚠️ WeChat: ${r.error}`);
  return r;
}
function runMsg(msg) {
  return new Promise((res) => {
    let done = false;
    const reply = (r) => { if (!done) { done = true; res(r); } };
    try { const keep = onMsg(msg, {}, reply); if (keep !== true) reply(undefined); } catch (e) { reply({ ok: false, error: e.message }); }
  });
}
async function bridgeHandle(msg) {
  if (!msg || !BRIDGE_ALLOWED.includes(msg.type)) return { ok: false, error: "команда не разрешена" };
  if (msg.type === "openTab") return openTabFront(String(msg.url || ""));
  if (msg.type === "szwegoAll") return szwegoAll(msg);
  if (msg.type === "status") {
    const [pub, a, b] = await Promise.all([runMsg({ type: "pubGet" }), runMsg({ type: "autoState" }), runMsg({ type: "batchState" })]);
    return { ok: true, version: chrome.runtime.getManifest().version, pub, auto: a && a.auto, openPids: (a && a.openPids) || [], batch: b && b.batch };
  }
  return runMsg(msg);
}
let bridgeRunning = false;
async function bridgeLoop() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  const ver = chrome.runtime.getManifest().version;
  // в каком браузере работает расширение — программа открывает именно его
  const ua = navigator.userAgent || "";
  const brw = /YaBrowser/.test(ua) ? "yandex" : /Edg\//.test(ua) ? "edge" : /OPR\//.test(ua) ? "opera" : /Vivaldi/.test(ua) ? "vivaldi"
    : (navigator.brave ? "brave" : "chrome");
  try {
    for (;;) {
      try {
        await chrome.runtime.getPlatformInfo(); // держит расширение «проснувшимся»
        const { port = DEFAULT_PORT } = await chrome.storage.local.get("port");
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 25000);
        let r = null;
        try { r = await (await fetch(`http://127.0.0.1:${port}/api/bridge/poll?v=${ver}&b=${brw}`, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
        if (r && r.reload) { chrome.runtime.reload(); return; } // программа обновилась — подхватываем новые файлы расширения
        if (r && r.cmd) {
          // команды выполняем параллельно: долгое скачивание альбома не мешает остальным кнопкам
          const cmd = r.cmd;
          (async () => {
            let result;
            try { result = await bridgeHandle(cmd.msg); } catch (e) { result = { ok: false, error: e.message }; }
            await fetch(`http://127.0.0.1:${port}/api/bridge/result`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: cmd.id, result: result === undefined ? null : result }) }).catch(() => {});
          })();
        }
      } catch (e) {
        await new Promise((ok) => setTimeout(ok, 4000)); // программа не запущена — ждём
      }
    }
  } finally { bridgeRunning = false; }
}
chrome.alarms.create("bridge", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((al) => { if (al.name === "bridge") bridgeLoop(); });
chrome.runtime.onStartup.addListener(() => bridgeLoop());
chrome.runtime.onInstalled.addListener(() => bridgeLoop());
bridgeLoop();
