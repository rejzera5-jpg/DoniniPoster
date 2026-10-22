// Donini Poster — основа окна: связь с программой, меню, предупреждения, общие окна (модальные, просмотр фото).
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const enc = encodeURIComponent;
function toast(t, err){ const d = document.createElement("div"); d.className = "toast" + (err ? " err" : ""); d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), err ? 6000 : 3200); }
async function api(path, opts={}){
  const r = await fetch(path, {headers: opts.raw ? {} : {"Content-Type":"application/json"}, ...opts,
    body: opts.raw ? opts.body : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)});
  if(!r.ok){ let m = r.statusText; try{ m = (await r.json()).detail || m; }catch(e){} throw new Error(m); }
  return r.json();
}
const post = (p, b={}) => api(p, {method:"POST", body:b});
// то же, но ошибку сразу показываем всплывающим сообщением
async function act(fn, okMsg){ try{ const r = await fn(); if(okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg); return r; }catch(e){ toast(e.message || String(e), true); return null; } }
async function ext(msg, timeout=15000){
  try{ const r = await post("/api/bridge/cmd", {msg, timeout: Math.round(timeout/1000)}); return r.ok ? r.result : null; }catch(e){ return null; }
}
function store(k, v){ try{ if(v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }catch(e){ return null; } }
function openUrl(url){ const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
const fmtDate = (s) => s ? String(s).slice(0, 16).replace("T", " ") : "";

let Q = null, META = {types: [], langs: []}, BR = null, page = store("page") || "home";
const STATE = {run:"работает", pause:"пауза", stop:"остановлена"};
const qById = (id) => (Q && Q.queues.find(q => q.id === id)) || null;
const siteById = (id) => (Q && Q.sites.find(s => s.id === id)) || null;
const siteName = (id) => (siteById(id) || {}).name || id;
const tplLabel = (id) => { const t = META.types.find(x => x.id === id); return t ? t.label : (id || "—"); };
const tplOpts = (cur) => META.types.map(t => `<option value="${esc(t.id)}" ${t.id === cur ? "selected" : ""}>${esc(t.label)}${t.custom ? " (свой)" : ""}</option>`).join("");
const boardQueues = () => Q ? Q.queues.filter(q => q.id !== "site") : [];
function folderOf(q){ return /^[a-zA-Z]:[\\/]/.test(q.folder) ? q.folder : (Q.queue_root + "\\" + q.folder); }
const editing = (root) => { const a = document.activeElement; return a && root && root.contains(a) && ["INPUT","SELECT","TEXTAREA"].includes(a.tagName) && !["checkbox","radio"].includes(a.type); };

// ---------- модальные окна ----------
function modal(html, cls){
  const ov = document.createElement("div"); ov.className = "ov";
  ov.innerHTML = `<div class="modal ${cls || ""}">${html}</div>`;
  ov.addEventListener("mousedown", e => { if(e.target === ov) ov.remove(); });
  ov.addEventListener("click", e => { if(e.target.closest("[data-x]")) ov.remove(); });
  document.body.appendChild(ov); return ov;
}
const closeX = `<button class="ghost" data-x title="Закрыть (Esc)">✕</button>`;
function choose(title, text, buttons){
  return new Promise(res => {
    const ov = modal(`<div class="mh"><h3>${esc(title)}</h3></div><div>${esc(text)}</div><div class="row">${buttons.map(([v, t, cls]) => `<button class="${cls || ""}" data-v="${v}">${esc(t)}</button>`).join("")}</div>`);
    ov.addEventListener("click", e => { const b = e.target.closest("[data-v]"); if(b){ ov.remove(); res(b.dataset.v); } });
    ov.addEventListener("mousedown", e => { if(e.target === ov) res(""); });
  });
}
function ask(title, label, value=""){
  return new Promise(res => {
    const ov = modal(`<div class="mh"><h3>${esc(title)}</h3>${closeX}</div><label class="field">${esc(label)}<input id="askV" value="${esc(value)}"></label>
      <div class="row"><button class="primary" id="askOk">OK</button><button data-x>Отмена</button></div>`);
    const i = $("#askV", ov); i.focus(); i.select();
    const ok = () => { const v = i.value; ov.remove(); res(v); };
    $("#askOk", ov).onclick = ok; i.onkeydown = e => { if(e.key === "Enter") ok(); };
    ov.addEventListener("click", e => { if(e.target.closest("[data-x]")) res(null); });
  });
}

// ---------- просмотр фото крупно ----------
// items: [{path, off, main}], onChange(item, "main"|"off"|"on") → {items, index}
function lightbox(items, start, onChange){
  let i = start;
  const el = document.createElement("div"); el.className = "lb";
  const draw = () => {
    const it = items[i];
    el.innerHTML = `<div class="top"><b>Фото ${i + 1} из ${items.length}</b>
        <span class="pill ${it.off ? "err" : "run"}">${it.off ? "не используется" : (it.main ? "⭐ главное" : "в объявлении")}</span><span class="spacer"></span>
        ${onChange ? (it.off ? `<button class="go" data-lb="on">↩ Вернуть в объявление</button>` :
          `${it.main ? "" : `<button data-lb="main">⭐ Сделать главным</button>`}<button class="danger" data-lb="off">✕ Не использовать</button>`) : ""}
        <button data-lb="close">Закрыть (Esc)</button></div>
      <div class="stage"><button class="nav2" style="left:16px" data-lb="prev">‹</button>
        <img src="/api/photo?path=${enc(it.path)}" onerror="this.src='/api/thumb?path=${enc(it.path)}&big=1'">
        <button class="nav2" style="right:16px" data-lb="next">›</button></div>
      <div class="strip">${items.map((x, k) => `<img src="/api/thumb?path=${enc(x.path)}" class="${k === i ? "on" : ""} ${x.off ? "off" : ""}" data-k="${k}">`).join("")}</div>`;
  };
  const go = (a) => {
    if(a === "close"){ el.remove(); removeEventListener("keydown", key, true); return; }
    if(a === "prev") i = (i - 1 + items.length) % items.length;
    if(a === "next") i = (i + 1) % items.length;
    if(["main", "off", "on"].includes(a) && onChange){ const r = onChange(items[i], a); if(r){ items = r.items; i = Math.min(r.index ?? i, items.length - 1); } }
    draw();
  };
  const key = (e) => {
    if(e.key === "Escape"){ e.stopPropagation(); e.preventDefault(); go("close"); }
    else if(e.key === "ArrowLeft") go("prev"); else if(e.key === "ArrowRight") go("next");
    else if(e.key === "Delete" && onChange) go(items[i].off ? "on" : "off");
  };
  el.addEventListener("click", e => { const b = e.target.closest("[data-lb]"); if(b) return go(b.dataset.lb);
    const t = e.target.closest("[data-k]"); if(t){ i = +t.dataset.k; draw(); } else if(e.target.classList.contains("stage")) go("close"); });
  addEventListener("keydown", key, true);
  draw(); document.body.appendChild(el);
}

// ---------- меню слева ----------
function navItem(q){
  const d = q.run === "run" ? (q.working || q.id === "site" ? "run" : "wait") : q.run === "pause" ? "pause" : "";
  const n = q.errors ? `<span class="n err" title="с ошибкой: ${q.errors}">${q.waiting}</span>` : `<span class="n">${q.waiting}</span>`;
  return `<button class="nav${page === "q:" + q.id ? " on" : ""}" data-q="${q.id}" title="${esc(STATE[q.run])}"><span class="ic"><i class="dot ${d}"></i></span><span>${esc(q.name)}</span>${n}</button>`;
}
function renderNav(){
  const main = Q.queues.filter(q => q.group === "main"), more = Q.queues.filter(q => q.group !== "main");
  $("#qMain").innerHTML = main.map(navItem).join("");
  $("#qMore").innerHTML = more.map(navItem).join("");
  $("#moreLbl").textContent = `Ещё (${more.length})`;
  $("#moreBtn").classList.toggle("hidden", !more.length);
  if(more.some(q => page === "q:" + q.id)) $("#qMore").classList.add("open");
  $("#moreArrow").textContent = $("#qMore").classList.contains("open") ? "▾" : "▸";
  $$("aside [data-page]").forEach(b => b.classList.toggle("on", page === b.dataset.page));
  $("#ver").textContent = "версия " + (Q.version || "").split("-")[0];
  $("#counter").textContent = Q.counter ?? "—";
  $("#extState").innerHTML = Q.ext_online ? `<span class="ok">●</span> Расширение на связи` + (BR && BR.current ? ` · ${esc(BR.names[BR.current] || BR.current)}` : "")
    : `<span class="err">●</span> Расширение не отвечает`;
  $("#tgState").innerHTML = Q.telegram_ok ? `<span class="ok">●</span> Telegram подключён` : `<span class="muted">○ Telegram не подключён</span>`;
  const noSc = Q.sites.filter(s => s.type !== "plugin" && boardQueues().some(q => q.sites.includes(s.id) && !s.scenarios[q.id] && !s.scenarios.default)).length;
  $("#nNoSc").textContent = noSc; $("#nNoSc").classList.toggle("hidden", !noSc);
  const errs = Q.queues.reduce((a, q) => a + q.errors, 0);
  $("#nErr").textContent = errs; $("#nErr").classList.toggle("hidden", !errs);
}
document.addEventListener("click", e => {
  const q = e.target.closest("aside [data-q]"); if(q){ go("q:" + q.dataset.q); return; }
  const p = e.target.closest("aside [data-page]"); if(p) go(p.dataset.page);
});
$("#moreBtn").onclick = () => { $("#qMore").classList.toggle("open"); renderNav(); };

const PAGES = {};  // имя → {show(), refresh()}
function go(p){
  if(!p.startsWith("q:") && !PAGES[p]) p = "home";
  page = p; store("page", p);
  $$("main > section").forEach(s => s.classList.add("hidden"));
  const name = p.startsWith("q:") ? "queue" : p;
  $("#page-" + name).classList.remove("hidden");
  if(PAGES[name] && PAGES[name].show) PAGES[name].show(p.startsWith("q:") ? p.slice(2) : null);
  if(Q) renderNav();
  $("main").scrollTop = 0;
}

// ---------- предупреждения сверху ----------
let UPD = null, PEND = null, WEB0 = null;
function renderBanners(){
  if(!Q) return;
  const b = [];
  const boardsRun = Q.queues.some(q => q.id !== "site" && q.run === "run");
  if(PEND && (PEND.restart || (PEND.web && WEB0 && PEND.web !== WEB0)))
    b.push(`<div class="banner ok"><div class="t">🔄 <b>Программу обновили</b> — ${PEND.restart ? "нажмите, чтобы применить (перезапуск около 10 секунд)" : "обновите окно"}.</div><button class="go" data-act="apply">${PEND.restart ? "Применить сейчас" : "Обновить окно"}</button></div>`);
  if(UPD && UPD.available)
    b.push(`<div class="banner ok"><div class="t">⬆ <b>Доступна новая версия ${esc(UPD.latest)}</b> (у вас ${esc(UPD.current)}).${UPD.notes ? ` <span class="small">${esc(UPD.notes.split("\n")[0].slice(0, 140))}</span>` : ""}</div><button class="go" data-act="update">Обновить</button></div>`);
  if(!Q.ext_online)
    b.push(`<div class="banner ${boardsRun ? "err" : "warn"}"><div class="t"><b>Расширение Donini в браузере не отвечает.</b> ${boardsRun ? "Выставление на доски стоит." : "Доски не выставляются, мой сайт работает."}
      <div class="small muted">Обычно хватает перезапустить браузер — программа откроет его сразу с расширением. В новом браузере расширение нужно поставить один раз.</div></div>
      <button data-act="brRestart">🔄 Перезапустить браузер</button><button data-act="extInstall">🧩 Поставить расширение</button></div>`);
  if(Q.manual_auto)
    b.push(`<div class="banner info"><div class="t">Выставление сейчас запущено кнопкой расширения в браузере${Q.auto && Q.auto.lineName ? ` («${esc(Q.auto.lineName)}»)` : ""}. Программа ему не мешает — кнопки Старт / Пауза / Стоп заработают, когда вы его остановите.</div>
      <button data-act="stopManual">■ Остановить его</button></div>`);
  if(BR && BR.default && BR.current && BR.default !== BR.current && BR.declined !== BR.default && BR.installed.includes(BR.default)){
    const nd = BR.names[BR.default] || BR.default, nc = BR.names[BR.current] || BR.current;
    b.push(`<div class="banner info"><div class="t"><b>Основной браузер Windows теперь ${esc(nd)}</b>, а выставление идёт в ${esc(nc)}. Перейти на ${esc(nd)}?
      <div class="small muted">Сценарии сайтов останутся. В новом браузере один раз поставьте расширение и войдите на сайты.</div></div>
      <button class="primary" data-act="brSwitch" data-b="${BR.default}">Перейти на ${esc(nd)}</button><button data-act="brStay" data-b="${BR.default}">Остаться на ${esc(nc)}</button></div>`);
  }
  const html = b.join("");
  if($("#banners").__h !== html){ $("#banners").innerHTML = html; $("#banners").__h = html; }
  $("#banners").classList.toggle("hidden", !b.length);
}
document.addEventListener("click", async e => {
  const a = e.target.closest("[data-act]"); if(!a) return;
  const k = a.dataset.act;
  if(k === "brRestart") await restartBrowser();
  if(k === "extInstall") extInstallModal(true);
  if(k === "stopManual") { await ext({type:"autoStop"}); toast("Остановлено"); }
  if(k === "brSwitch"){ await act(() => post("/api/app/browser", {choice: a.dataset.b})); await loadBrowser(); extInstallModal(true); }
  if(k === "brStay"){ await act(() => post("/api/app/browser", {decline: a.dataset.b})); await loadBrowser(); }
  if(k === "apply") applyChanges();
  if(k === "update") updInstall();
  refresh();
});
async function restartBrowser(){
  if(Q && Q.queues.some(q => q.working && q.id !== "site") && !confirm("Сейчас идёт выставление. Перезапустить браузер? Он закроется и откроется снова, вкладки вернутся.")) return;
  await act(() => post("/api/browser/restart"), "Перезапускаю браузер с расширением… (до 30 секунд)");
}
async function extInstallModal(open){
  let r = null;
  if(open){ try{ r = await post("/api/browser/open_extensions"); }catch(e){} }
  const pg = (r && r.page) || "chrome://extensions";
  const ov = modal(`<div class="mh"><h3>🧩 Поставить расширение Donini (один раз)</h3>${closeX}</div>
    <ol class="steps">
      <li>${r && r.browser ? `В ${esc(r.browser)} открылась` : "В браузере откройте"} страница <code>${esc(pg)}</code> — если нет, вставьте этот адрес в адресную строку.</li>
      <li>Включите <b>«Режим разработчика»</b> (переключатель на странице).</li>
      <li>Нажмите <b>«Загрузить распакованное расширение»</b> и выберите папку <code>${esc((r && r.folder) || "DoniniPoster\\extension")}</code>${r ? " — она уже открыта" : ""}.</li>
      <li>Закрепите значок Donini на панели браузера. Через несколько секунд слева внизу загорится «● Расширение на связи».</li>
    </ol>
    <div class="small muted">Потом войдите в аккаунты на сайтах: Настройки → Сайты → «🔑 Войти». Записанные сценарии остаются — заново записывать не нужно.</div>
    <div class="row">${open ? "" : `<button class="primary" id="extOpen">Открыть страницу расширений</button>`}<button data-x>Готово</button></div>`);
  const b = $("#extOpen", ov); if(b) b.onclick = () => { ov.remove(); extInstallModal(true); };
}
async function loadBrowser(){ try{ BR = await api("/api/app/browser"); }catch(e){} }

// ---------- обновления программы ----------
async function updLoad(force){ try{ UPD = await api("/api/update/status" + (force ? "?force=1" : "")); }catch(e){} renderBanners(); return UPD; }
async function updInstall(){
  if(!UPD || !UPD.available) return;
  if(!confirm(`Обновить программу до версии ${UPD.latest}?\n\nНастройки, сценарии и очередь сохранятся. Программа перезапустится сама (около 20 секунд).`)) return;
  const old = (await api("/api/version").catch(() => ({}))).version;
  modal(`<div class="row"><div class="spin"></div><b>Скачиваю обновление ${esc(UPD.latest)}…</b></div><div class="small muted">Окно обновится само.</div>`);
  const r = await act(() => post("/api/update/install"));
  if(!r){ location.reload(); return; }
  waitRestart(old);
}
async function pendLoad(){ try{ PEND = await api("/api/app/pending"); if(WEB0 === null) WEB0 = PEND.web; }catch(e){} renderBanners(); }
async function applyChanges(){
  if(!PEND || !PEND.restart){ location.reload(); return; }
  if(!confirm("Применить изменения программы? Она перезапустится (около 10 секунд). Очереди, которые работали, продолжат сами.")) return;
  modal(`<div class="row"><div class="spin"></div><b>Перезапускаю программу…</b></div><div class="small muted">Окно обновится само.</div>`);
  const old = PEND.running;
  try{ await post("/api/app/restart"); }catch(e){}
  waitRestart(old);
}
async function waitRestart(old){
  const t0 = Date.now();
  while(Date.now() - t0 < 120000){
    await new Promise(r => setTimeout(r, 1500));
    try{ const r = await fetch("/api/version", {cache: "no-store"}); if(r.ok){ const v = (await r.json()).version; if(v && v !== old){ location.reload(); return; } } }catch(e){}
  }
  toast("Программа не ответила за 2 минуты — запустите её ярлыком «Donini Poster»", true);
}

// ---------- поиск товара по всей программе ----------
async function searchModal(q){
  q = (q || "").trim(); if(q.length < 2) return;
  let r; try{ r = await api("/api/search?q=" + enc(q)); }catch(e){ return; }
  const ST = {done:"✓", error:"ошибка", pending:"ждёт", running:"выставляется", skipped:"пропущен"};
  const ov = modal(`<div class="mh"><h3>🔎 «${esc(q)}» — найдено ${r.total}</h3>${closeX}</div>
    <input id="srQ" value="${esc(q)}" placeholder="код или название">
    <div style="display:flex;flex-direction:column;gap:10px">${r.items.map(h => `<div class="card inset" data-pid="${h.id}">
      <div class="row" style="align-items:flex-start"><div style="flex:1;min-width:240px"><span class="code">${esc(h.code)}</span> ${esc(h.name)}
        <div class="small muted">${esc(h.line || "")} · ${h.size ? esc(h.size) + " · " : ""}${h.price ? esc(h.price) + " zł · " : ""}${h.n_photos} фото · ${h.status === "archived" ? "выставлен " + esc(fmtDate(h.archived_at)) : "в очереди с " + esc(fmtDate(h.added))}</div></div>
        <button class="sm" data-a="copy" data-v="${esc(h.code)}">📋 Код</button>
        ${h.status !== "archived" ? `<button class="sm" data-a="card">🗂 Карточка</button>` : ""}
        ${h.folder_exists ? `<button class="sm" data-a="folder" data-v="${esc(h.folder)}">📂 Папка</button>` : ""}
        ${h.sites.some(x => x.status === "error") ? `<button class="sm primary" data-a="retry">↻ Повторить ошибки</button>` : ""}</div>
      <div>${h.sites.map(x => x.status === "done" && x.url ? `<a class="chip done" data-a="open" data-v="${esc(x.url)}">${esc(x.name)} ✓ ↗</a>` : `<span class="chip ${x.status}" title="${esc(x.error || "")}">${esc(x.name)}: ${ST[x.status] || x.status}</span>`).join("") || `<span class="muted small">сайтов нет</span>`}</div>
    </div>`).join("") || `<div class="empty">Ничего не найдено</div>`}</div>`, "w2");
  const inp = $("#srQ", ov); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.onkeydown = e => { if(e.key === "Enter"){ ov.remove(); searchModal(inp.value); } };
  ov.addEventListener("click", async e => {
    const b = e.target.closest("[data-a]"); if(!b) return;
    const pid = b.closest("[data-pid]")?.dataset.pid, v = b.dataset.v;
    if(b.dataset.a === "copy"){ try{ await navigator.clipboard.writeText(v); }catch(er){} toast("Код скопирован: " + v); }
    if(b.dataset.a === "folder") post("/api/open_folder", {path: v});
    if(b.dataset.a === "open") openUrl(v);
    if(b.dataset.a === "card"){ ov.remove(); cardModal(pid); }
    if(b.dataset.a === "retry"){ await act(() => post(`/api/product/${pid}/retry`, {}), "Снова в очереди"); ov.remove(); searchModal(q); }
  });
}
$("#gSearch").addEventListener("keydown", e => { if(e.key === "Enter"){ searchModal(e.target.value); } if(e.key === "Escape") e.target.blur(); });

// ---------- горячие клавиши ----------
document.addEventListener("keydown", e => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if(e.key === "Escape"){ const m = $$(".ov").pop(); if(m){ m.remove(); e.preventDefault(); } return; }
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" || (!typing && e.key === "/")){ e.preventDefault(); $("#gSearch").focus(); $("#gSearch").select(); return; }
  if(!e.altKey || e.ctrlKey || typing) return;
  const d = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : null;
  if(d === 0){ e.preventDefault(); go("home"); }
  if(d){ const qs = Q ? Q.queues.filter(q => q.group === "main") : []; if(qs[d - 1]){ e.preventDefault(); go("q:" + qs[d - 1].id); } }
});

// ---------- журнал ----------
PAGES.log = {show: loadLog};
const logCls = (l) => /❌|Ошибка/.test(l) ? "e" : /⚠️/.test(l) ? "w" : /✅/.test(l) ? "o" : "";
async function loadLog(){
  if(page !== "log") return;
  let d; try{ d = await api("/api/logs?n=400"); }catch(e){ return; }
  const q = $("#logQ").value.trim().toLowerCase(), eo = $("#logErr").checked;
  const lines = d.logs.slice().reverse().filter(l => (!q || l.toLowerCase().includes(q)) && (!eo || /❌|⚠️|Ошибка/.test(l)));
  const html = lines.map(l => `<div class="${logCls(l)}">${esc(l)}</div>`).join("") || `<div class="muted">пусто</div>`;
  if($("#logList").__h !== html){ $("#logList").innerHTML = html; $("#logList").__h = html; }
}
$("#logErr").onchange = loadLog; $("#logQ").oninput = loadLog;

// ---------- обновление данных ----------
async function refresh(){
  try{ Q = await api("/api/queues"); }catch(e){ $("#extState").textContent = "Программа не отвечает…"; return; }
  renderNav(); renderBanners();
  const name = page.startsWith("q:") ? "queue" : page;
  if(PAGES[name] && PAGES[name].refresh) PAGES[name].refresh();
}
async function boot(){
  try{ META = await api("/api/meta"); }catch(e){}
  await refresh(); await loadBrowser(); renderBanners();
  if(page.startsWith("q:") && !qById(page.slice(2))) page = "home";
  go(page);
  setInterval(refresh, 3000);
  setInterval(loadLog, 3000);
  setInterval(() => loadBrowser().then(renderBanners), 60000);
  setTimeout(() => updLoad(false), 4000); setInterval(() => updLoad(false), 600000);
  pendLoad(); setInterval(pendLoad, 15000);
}
