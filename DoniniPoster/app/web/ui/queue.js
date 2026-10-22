// Страница очереди: Старт / Пауза / Стоп, товары, действия с товарами, карточка товара, тексты, настройки очереди.
let QID = null, TAB = "wait", LIST = [], listSig = "", SEL = new Set(), SEL_LAST = null, setOpen = false, EXTST = null;
const ST_TXT = {pending:"ждёт", running:"выставляется", done:"опубликовано", error:"ошибка", skipped:"пропущен"};
const UP = {};  // загрузка перетаскиванием: id очереди → {done,total,msg,err}

PAGES.queue = {
  show(id){ if(id !== QID){ QID = id; TAB = "wait"; SEL.clear(); setOpen = false; listSig = ""; } drawQueue(); loadList(true); loadExtState(); },
  refresh(){ updateQueue(); },
};
setInterval(() => { if(page.startsWith("q:")) { loadList(); loadExtState(); } }, 4000);
async function loadExtState(){ if(!Q || !Q.ext_online){ EXTST = null; return; } const r = await ext({type:"status"}, 6000); EXTST = r && r.ok !== false ? r : null; updateBatch(); }

function drawQueue(){
  const q = qById(QID); const box = $("#page-queue");
  if(!q){ box.innerHTML = `<div class="empty">Очередь не найдена</div>`; return; }
  const site = q.id === "site";
  box.innerHTML = `
    <div class="qhead"><h1 id="qTitle"></h1><span id="qPill" class="pill"></span><span class="spacer"></span><span id="qStatus" class="muted small"></span></div>
    <div class="big3">
      <button class="big go" data-run="run">▶ Старт</button>
      <button class="big pa" data-run="pause">⏸ Пауза</button>
      <button class="big st" data-run="stop">■ Стоп</button>
    </div>
    <div class="small muted" id="qHint"></div>
    <div id="qBatch"></div>
    <div class="tiles">
      <div class="tile click" data-tabgo="wait"><b id="tWait">0</b><span>ждут</span></div>
      <div class="tile click" data-tabgo="done"><b id="tToday">0</b><span>опубликовано сегодня</span></div>
      <div class="tile click" data-tabgo="err"><b id="tErr">0</b><span>с ошибкой</span></div>
      <div class="tile click" id="tSitesT"><b id="tSites">0</b><span id="tSitesL"></span></div>
    </div>
    <div class="drop" id="qDrop"><b>📥 Перетащите сюда папки с товарами</b> — или нажмите, чтобы выбрать папку.
      <span class="small">Можно сразу много папок или одну общую. Новые товары получат коды и встанут в очередь.</span><div id="qUp"></div></div>
    <div id="qSet" class="hidden"></div>
    <div class="card">
      <div class="toolbar">
        <div class="tabs" id="qTabs">
          <button data-tab="wait">Ждут <span class="n" id="cWait"></span></button>
          <button data-tab="done">Опубликовано</button>
          <button data-tab="err">Ошибки <span class="n" id="cErr"></span></button>
        </div>
        <input id="qFind" placeholder="🔎 найти в очереди: код, название, бренд" style="width:240px">
        <button id="qRetryAll" class="hidden">↻ Повторить все ошибки</button>
        <span class="spacer"></span>
        <button id="qFolder" title="Открыть папку этой очереди в проводнике">📂 Папка</button>
        <div class="menu" id="qMenu"><button id="qMenuBtn">⋯ Действия</button><div class="pop">
          ${site ? "" : `<button data-qa="batch">📦 Пачкой на один сайт…</button>`}
          <button data-qa="mgr">🧾 Открыть шаблон в Donini Manager</button>
          <button data-qa="tplreset">↺ Все тексты — по шаблону</button>
          ${site ? "" : `<button data-qa="sizes">📏 Размеры с моего сайта (у кого нет)</button>`}
          <button data-qa="qc">🧹 Проверить фото всей очереди</button>
          <hr><button data-qa="clear" class="danger">🗑 Очистить очередь…</button></div></div>
        <button id="qSetBtn">⚙️ Настройки очереди</button>
      </div>
      <div id="qBulk"></div>
      <div id="qList"></div>
    </div>`;
  $$("[data-run]", box).forEach(b => b.onclick = () => runQueue(b.dataset.run, QID));
  $$("[data-tab]", box).forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $$("[data-tabgo]", box).forEach(b => b.onclick = () => setTab(b.dataset.tabgo));
  $("#tSitesT").onclick = () => { setOpen = true; drawSet(); };
  $("#qFolder").onclick = () => post("/api/open_folder", {path: folderOf(qById(QID))});
  $("#qFind").oninput = () => drawList();
  $("#qRetryAll").onclick = async () => { const ids = LIST.filter(p => p.sites.some(s => s.status === "error")).map(p => p.id);
    if(!ids.length) return; if(await act(() => post("/api/products/bulk", {ids, action: "retry"}), `↻ Снова в очереди: ${ids.length}`)){ listSig = ""; loadList(true); refresh(); } };
  $("#qSetBtn").onclick = () => { setOpen = !setOpen; drawSet(); };
  $("#qMenuBtn").onclick = (e) => { e.stopPropagation(); $("#qMenu").classList.toggle("open"); };
  $("#qMenu .pop").onclick = (e) => { const b = e.target.closest("[data-qa]"); $("#qMenu").classList.remove("open"); if(b) queueAction(b.dataset.qa); };
  const drop = $("#qDrop");
  drop.onclick = () => pickFolder(QID);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove("over"); uploadTo(QID, await collectDropped(e.dataTransfer)); };
  $("#qList").addEventListener("click", listClick);
  $("#qList").addEventListener("change", listChange);
  $("#qBulk").addEventListener("click", bulkClick);
  $("#qBulk").addEventListener("change", bulkChange);
  setTab(TAB, true); updateQueue(); drawSet();
}
document.addEventListener("click", () => { const m = $("#qMenu"); if(m) m.classList.remove("open"); });

function updateQueue(){
  const q = qById(QID); if(!q || !$("#qTitle")) return;
  $("#qTitle").textContent = q.name;
  const pill = $("#qPill");
  const waitBr = q.run === "run" && q.id !== "site" && !q.working;
  pill.className = "pill " + (q.run === "run" ? (waitBr ? "info" : "run") : q.run === "pause" ? "pause" : "");
  pill.textContent = waitBr ? "запущена · ждёт браузер" : STATE[q.run];
  $$("[data-run]").forEach(b => b.classList.toggle("cur", b.dataset.run === q.run));
  let status = "";
  if(q.id === "site") status = q.status || "";
  else if(q.run === "run" && Q.auto && Q.auto.owner === "program"){
    const A = Q.auto, wu = A.waitUntil && A.waitFor === A.pid ? A.waitUntil : 0, left = Math.round((wu - Date.now()) / 1000);
    status = (left > 0 ? `⏳ следующий товар через ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "⚙️ идёт выставление") +
      ` · за этот запуск: ${A.count || 0}` + (A.lineName && A.lineName.includes(",") ? ` · вместе: ${A.lineName}` : "");
  }
  $("#qStatus").textContent = status;
  $("#qHint").textContent = q.id === "site" ? "Загрузка на doninisklep.com идёт в самой программе, без браузера, одновременно с досками. Подключение — «⚙️ Настройки очереди»."
    : !q.sites.length ? "⚠️ У этой очереди не выбраны сайты — нажмите «⚙️ Настройки очереди» и отметьте сайты."
    : "Пауза — текущий товар доделается, новые не начнутся. Стоп — вкладки закрываются сразу, невыставленное остаётся в очереди.";
  $("#tWait").textContent = q.waiting; $("#tToday").textContent = q.done_today;
  $("#tErr").textContent = q.errors; $("#tErr").style.color = q.errors ? "var(--err)" : "";
  $("#tSites").textContent = q.sites.length;
  $("#tSitesL").textContent = q.sites.length ? q.sites.map(siteName).join(", ") : "сайтов не выбрано";
  $("#cWait").textContent = q.waiting; $("#cErr").textContent = q.errors;
  $("#cErr").classList.toggle("hidden", !q.errors);
  const u = UP[QID];
  $("#qUp").innerHTML = u ? (u.total && u.done < u.total ? `<div class="pbar"><i style="width:${Math.round(u.done / u.total * 100)}%"></i></div><div class="small">загружаю ${u.done} из ${u.total} файлов…</div>` : "") +
    (u.msg ? `<div class="small ${u.err ? "err" : "ok"}" style="margin-top:6px">${esc(u.msg)}</div>` : "") : "";
}
function updateBatch(){
  const box = $("#qBatch"); if(!box) return;
  const B = EXTST && EXTST.batch;
  const q = qById(QID);
  box.innerHTML = B && q && B.line === q.id ? `<div class="banner info"><div class="t">📦 <b>Пачка: ${esc(B.lineName)} → ${esc(B.siteName)}</b> — выставлено ${B.done || 0} из ${B.target}${B.skipped ? `, пропущено ${B.skipped}` : ""}. Следующий товар откроется сам.</div>
    <button class="danger" id="bStop">■ Остановить пачку</button></div>` : "";
  const s = $("#bStop"); if(s) s.onclick = async () => { await ext({type:"batchStop"}); loadExtState(); };
}

async function runQueue(state, id){
  const q = qById(id || QID); if(!q || q.run === state) return;
  let together = false;
  if(state === "run" && q.id !== "site"){
    const others = boardQueues().filter(o => o.id !== q.id && o.run === "run");
    if(others.length){
      const names = others.map(o => o.name).join(", ");
      const c = await choose(`Сейчас выставляется «${names}»`,
        `Переключиться на «${q.name}»? Текущий товар доделается, «${names}» встанет на паузу. Или запустить вместе — товары пойдут вперемешку.`,
        [["switch", `Переключиться на «${q.name}»`, "primary"], ["together", "Запустить вместе"], ["", "Отмена"]]);
      if(!c) return;
      together = c === "together";
    }
  }
  if(state === "stop" && q.id !== "site" && q.working && !confirm(`Остановить «${q.name}» сразу? Открытые вкладки закроются, невыставленное останется в очереди.`)) return;
  const r = await act(() => post(`/api/queue/${q.id}/run`, {state, together}));
  if(r) toast(`«${q.name}»: ${STATE[state]}` + (r.paused_others && r.paused_others.length ? ` · на паузу: ${r.paused_others.join(", ")}` : ""));
  refresh();
}
function setTab(t, quiet){ TAB = t; $$("#qTabs [data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === t)); if(!quiet){ listSig = ""; SEL.clear(); loadList(true); } }

// ---------- список товаров ----------
async function loadList(force){
  if(!page.startsWith("q:") || !QID) return;
  if(!force && (editing($("#qList")) || document.querySelector(".ov,.lb"))) return;
  const want = QID + "/" + TAB;
  let d; try{ d = await api(`/api/queue/${QID}/products?tab=${TAB}&limit=500`); }catch(e){ return; }
  if(want !== QID + "/" + TAB) return;
  const sig = JSON.stringify(d.products.map(p => [p.id, p.price, p.size, p.template, p.no_brand, p.own_text, p.photos, p.sites.map(s => s.status)])) + d.total;
  if(sig === listSig && !force) return;
  listSig = sig; LIST = d.products;
  for(const id of [...SEL]) if(!LIST.some(p => p.id === id)) SEL.delete(id);
  drawList(d.total);
}
let LIST_TOTAL = 0;
function drawList(total){
  if(total !== undefined) LIST_TOTAL = total; total = LIST_TOTAL;
  const q = qById(QID); const box = $("#qList"); if(!box) return;
  $("#qRetryAll").classList.toggle("hidden", !(TAB === "err" && LIST.length));
  const fq = ($("#qFind").value || "").trim().toLowerCase();
  const ALL = LIST, VIS = fq ? LIST.filter(p => `${p.code} ${p.name} ${p.brand}`.toLowerCase().includes(fq)) : LIST;
  drawBulk();
  if(fq && ALL.length && !VIS.length){ box.innerHTML = `<div class="empty">Ничего не найдено по «${esc(fq)}»</div>`; return; }
  if(!LIST.length){
    box.innerHTML = `<div class="empty">${TAB === "wait" ? `Здесь пусто. Перетащите папки с товарами в рамку выше — или положите их в папку <code>${esc(q ? folderOf(q) : "")}</code>, через несколько секунд они появятся здесь.` : TAB === "err" ? "Ошибок нет 👍" : "Пока ничего не опубликовано."}</div>`;
    return;
  }
  const live = TAB !== "done";
  const qline = q || {};
  const all = VIS.length && VIS.every(p => SEL.has(p.id));
  box.innerHTML = `<table><colgroup><col style="width:30px"><col style="width:62px"><col style="width:80px"><col><col style="width:150px"><col style="width:86px"><col style="width:30%"><col style="width:120px"></colgroup>
    <tr><th><input type="checkbox" data-selall ${all ? "checked" : ""} title="Выбрать все (Shift+клик — диапазон)"></th><th>Фото</th><th>Код</th><th>Товар</th><th>${qline.template === "phonecases" ? "Модель" : "Размер"}</th><th>Цена, zł</th><th>Сайты</th><th></th></tr>` +
    VIS.map(p => {
      const sel = SEL.has(p.id);
      const meta = [
        p.template ? `<span class="badge" title="Свой шаблон у этого товара">🧾 ${esc(tplLabel(p.template))}</span>` : "",
        p.own_text ? `<span class="badge warn" title="Текст поправлен вручную — шаблон к нему не применяется">✏️ свой текст</span>` : "",
        p.qc_bad ? `<span class="badge" title="Плохие фото убраны автоматически — вернуть можно в карточке">🧹 убрано фото: ${p.qc_bad}</span>` : "",
        p.photos_manual ? `<span class="badge ok">✋ фото выбраны вручную</span>` : "",
        live ? `<button class="brandbtn ${p.no_brand ? "off" : ""}" data-a="brand" title="${p.no_brand ? "Без бренда на всех сайтах — нажмите, чтобы включить" : "С брендом (на сайтах, где бренд включён) — нажмите, чтобы убрать"}">🏷 ${p.brand ? esc(p.brand) : "бренд"}</button>` : (p.brand ? `<span>🏷 ${esc(p.brand)}</span>` : ""),
        `<span>${p.photos} фото</span>`, TAB === "done" && p.archived_at ? `<span>выставлен ${esc(fmtDate(p.archived_at))}</span>` : "",
      ].filter(Boolean).join("");
      const chips = p.sites.map(s => s.status === "done" && s.url ? `<a class="chip done" href="${esc(s.url)}" target="_blank" title="Открыть объявление">${esc(s.name)} ✓</a>`
        : `<span class="chip ${s.status}" ${s.status === "error" ? `data-err="${s.id}"` : ""} title="${esc(ST_TXT[s.status] || s.status)}${s.error ? ": " + esc(s.error) : ""}">${esc(s.name)}${s.status === "done" ? " ✓" : s.status === "error" ? " !" : ""}</span>`).join("")
        || `<span class="small warn">нет сайтов</span>`;
      return `<tr data-pid="${p.id}" class="${sel ? "sel" : ""}">
        <td><input type="checkbox" data-sel ${sel ? "checked" : ""}></td>
        <td>${p.thumb ? `<img class="thumb" loading="lazy" src="${p.thumb}" data-a="photos" title="Посмотреть фото крупно — можно убрать лишние">` : ""}</td>
        <td class="code">${esc(p.code)}</td>
        <td><div class="pname" data-a="card" title="Открыть карточку товара">${esc(p.name)}</div><div class="meta">${meta}</div></td>
        <td>${live ? `<input class="cell" data-edit="size" value="${esc(p.size)}" placeholder="—">` : esc(p.size)}</td>
        <td>${live ? `<input class="cell${+p.price > 0 ? "" : " noprice"}" data-edit="price" value="${esc(p.price || "")}" placeholder="цена!" title="${+p.price > 0 ? "" : "Без цены доски не дают выставить"}">` : esc(p.price || "")}</td>
        <td>${chips}</td>
        <td class="acts">${live ? `${p.sites.some(s => s.status === "error") ? `<button data-a="retry" title="Повторить ошибки">↻</button>` : ""}
          <button data-a="texts" title="Название и описание по странам">✏️</button><button data-a="card" title="Карточка: фото, бренд, сайты">🗂</button>
          <button data-a="folder" title="Открыть папку товара">📂</button><button data-a="remove" title="Убрать из очереди">✕</button>`
          : `<button data-a="card" title="Карточка">🗂</button>`}</td></tr>`;
    }).join("") + `</table>` + (total > LIST.length ? `<div class="small muted" style="padding:8px">Показаны первые ${LIST.length} из ${total}.</div>` : "");
}
let shiftDown = false;
document.addEventListener("mousedown", e => { shiftDown = e.shiftKey; }, true);
async function listClick(e){
  const tr = e.target.closest("tr[data-pid]");
  if(e.target.matches("[data-selall]")){ e.target.checked ? $$("#qList tr[data-pid]").forEach(r => SEL.add(r.dataset.pid)) : SEL.clear(); drawList(); return; }
  if(!tr) return;
  const pid = tr.dataset.pid, p = LIST.find(x => x.id === pid);
  if(e.target.matches("[data-sel]")){
    const ids = $$("#qList tr[data-pid]").map(r => r.dataset.pid), i = ids.indexOf(pid), j = ids.indexOf(SEL_LAST);
    const on = e.target.checked;
    if(shiftDown && j >= 0) ids.slice(Math.min(i, j), Math.max(i, j) + 1).forEach(id => on ? SEL.add(id) : SEL.delete(id));
    else on ? SEL.add(pid) : SEL.delete(pid);
    SEL_LAST = pid; drawList(); return;
  }
  const er = e.target.closest("[data-err]"); if(er){ errModal(p, er.dataset.err); return; }
  const b = e.target.closest("[data-a]"); if(!b) return;
  const a = b.dataset.a;
  if(a === "card") return cardModal(pid);
  if(a === "texts") return textsModal(pid);
  if(a === "photos") return quickPhotos(pid);
  if(a === "folder") return post("/api/open_folder", {path: p.folder});
  if(a === "retry") await act(() => post(`/api/product/${pid}/retry`, {}), "Снова в очереди");
  if(a === "brand") await act(() => post(`/api/product/${pid}`, {no_brand: !p.no_brand}), p.no_brand ? "🏷 Товар — с брендом" : "Товар — без бренда на всех сайтах");
  if(a === "remove"){ if(!confirm(`Убрать товар ${p.code} из очереди?\n\nПапка с фото перенесётся в «_удалено» — оттуда её можно вернуть.`)) return;
    await act(() => api(`/api/product/${pid}`, {method:"DELETE"}), "Убрано"); }
  listSig = ""; loadList(true); refresh();
}
async function listChange(e){
  const i = e.target.closest("[data-edit]"); if(!i) return;
  const pid = i.closest("tr").dataset.pid;
  if(await act(() => post(`/api/product/${pid}`, {[i.dataset.edit]: i.value}))){ toast(i.dataset.edit === "price" ? "Цена сохранена" : "Сохранено"); i.blur(); listSig = ""; loadList(true); }
}
function errModal(p, sid){
  const s = p.sites.find(x => x.id === sid) || {};
  const ov = modal(`<div class="mh"><h3>Товар <span class="code">${esc(p.code)}</span> — ${esc(s.name)}: ошибка</h3>${closeX}</div>
    <div class="banner err"><div class="t">${esc(s.error || "без описания")}</div></div>
    ${s.shot ? `<img src="${s.shot}" style="max-width:100%;border-radius:10px;border:1px solid var(--border)">` : ""}
    <div class="small muted">Если сайт поменял форму — перезапишите сценарий: Настройки → Сайты → «● Записать». Если выставили сами — «Выставлено вручную».</div>
    <div class="row"><button class="primary" data-m="retry">↻ Повторить</button><button data-m="mark_done">✓ Выставлено вручную</button><button data-m="skip">Пропустить этот сайт</button>
      <span class="spacer"></span><button data-m="card">🗂 Карточка</button></div>`);
  ov.addEventListener("click", async e => {
    const m = e.target.closest("[data-m]"); if(!m) return;
    if(m.dataset.m === "card"){ ov.remove(); cardModal(p.id); return; }
    await act(() => post(`/api/product/${p.id}/${m.dataset.m}`, {site: sid}), {retry: "Снова в очереди на этот сайт", mark_done: "Отмечено как выставленное", skip: "Сайт пропущен"}[m.dataset.m]);
    ov.remove(); listSig = ""; loadList(true); refresh();
  });
}

// ---------- выбранные товары ----------
function drawBulk(){
  const box = $("#qBulk"); if(!box) return;
  const n = [...SEL].length;
  if(!n || TAB === "done"){ box.innerHTML = ""; return; }
  const lines = Q.queues.filter(l => (l.id === "site") === (QID === "site") && l.id !== QID);
  box.innerHTML = `<div class="bulk"><b>Выбрано: ${n}</b>
    <button class="sm" data-b="top" title="Эти товары выставятся раньше остальных">⏫ Первыми</button>
    <button class="sm" data-b="retry">↻ Повторить ошибки</button>
    <button class="sm" data-b="price">💰 Цена…</button><button class="sm" data-b="size">📏 Размер…</button>
    <select data-bs="template"><option value="">🧾 Шаблон…</option><option value="__line">как у очереди</option>${tplOpts("")}</select>
    ${lines.length ? `<select data-bs="line"><option value="">➡ В другую очередь…</option>${lines.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}</select>` : ""}
    <button class="sm" data-b="brand_on">🏷 С брендом</button><button class="sm" data-b="brand_off">Без бренда</button>
    <button class="sm" data-b="ai_brand" title="ИИ посмотрит фото и поставит бренд (нужен ключ: Настройки → Бренд по фото)">🤖 Бренд по фото</button>
    <button class="sm" data-b="qc">🧹 Проверить фото</button><button class="sm" data-b="texts_reset">↺ Текст по шаблону</button>
    <select data-bs="recent"><option value="">☑ Добавить недавние…</option><option value="30">за 30 минут</option><option value="60">за 1 час</option><option value="180">за 3 часа</option><option value="1440">за сутки</option></select>
    <button class="sm danger" data-b="remove">🗑 Убрать</button><span class="spacer"></span><button class="sm ghost" data-b="clear">✕ Снять выбор</button></div>`;
}
function bulkClick(e){ const b = e.target.closest("[data-b]"); if(b) doBulk(b.dataset.b); }
function bulkChange(e){
  const s = e.target.closest("[data-bs]"); if(!s || !s.value) return;
  const v = s.value; s.value = "";
  if(s.dataset.bs === "recent"){ const since = Date.now() - v * 60000; LIST.forEach(p => { if(new Date(p.added).getTime() >= since) SEL.add(p.id); }); drawList(); return; }
  doBulk(s.dataset.bs, s.dataset.bs === "template" && v === "__line" ? "" : v);
}
async function doBulk(action, value){
  const ids = [...SEL]; if(!ids.length) return;
  if(action === "clear"){ SEL.clear(); drawList(); return; }
  if(action === "ai_brand"){ toast(`🤖 Смотрю фото ${ids.length} товаров…`); const r = await act(() => post("/api/queue/ai_brand", {ids})); if(r){ r.ok === false ? toast(r.error, true) : toast(`🤖 Бренд найден: ${r.found}` + (r.miss ? `, не понял: ${r.miss}` : "")); } }
  else if(action === "qc"){ const r = await act(() => post("/api/queue/qc_recheck", {ids})); if(r) toast(`🧹 Проверяю фото: ${r.count} товаров`); }
  else {
    if(action === "remove" && !confirm(`Убрать из очереди выбранные товары (${ids.length})?\n\nПапки переносятся в «_удалено» — их можно вернуть.`)) return;
    if(action === "price"){ value = await ask(`Цена для ${ids.length} товаров`, "Цена, zł"); if(!value) return; }
    if(action === "size"){ value = await ask(`Размер для ${ids.length} товаров`, "Например 30x20x10"); if(value === null) return; }
    const r = await act(() => post("/api/products/bulk", {ids, action, value}));
    if(r) toast(`Готово: ${r.done}`);
    if(action === "remove" || action === "line") SEL.clear();
  }
  listSig = ""; setTimeout(() => loadList(true), 600); refresh();
}

// ---------- меню «Действия» ----------
async function queueAction(a){
  const q = qById(QID);
  if(a === "batch") return batchModal(q);
  if(a === "mgr") return openManager(q.template);
  if(a === "tplreset"){ const r = await act(() => post("/api/queue/texts_reset", {only: q.id === "site" ? "site" : "boards", line: q.id})); if(r) toast(r.reset ? `↺ Тексты по шаблону: ${r.reset} товаров` : "Все товары и так берут текст из шаблона"); }
  if(a === "sizes"){ toast("📏 Беру размеры с сайта…"); const r = await act(() => post("/api/queue/sizes_from_site", {ids: LIST.filter(p => !p.size).map(p => p.id)}));
    if(r) toast(r.candidates ? `📏 Размер подставлен: ${r.done}${r.missing ? ` · не найден: ${r.missing}` : ""}` : "Нет товаров без размера, скачанных с моего сайта"); }
  if(a === "qc"){ if(!confirm(`Проверить фото всех товаров «${q.name}» заново? Фото, выбранные вручную, не трогаются.`)) return;
    const r = await act(() => post("/api/queue/qc_recheck", {ids: LIST.map(p => p.id)})); if(r) toast(`🧹 Проверяю фото: ${r.count} товаров`); }
  if(a === "clear"){
    if(!q.total) return toast("Очередь и так пуста");
    if(!confirm(`Убрать из «${q.name}» все невыставленные товары (${q.total})?\n\nПапки с фото переносятся в «_удалено» внутри папки очереди. Выставленные товары не затрагиваются.`)) return;
    const r = await act(() => post("/api/queue/clear", {only: q.id === "site" ? "site" : "boards", line: q.id}));
    if(r) toast(`Убрано: ${r.removed}` + (r.failed ? `, не получилось: ${r.failed}` : ""));
  }
  listSig = ""; loadList(true); refresh();
}
async function batchModal(q){
  if(!Q.ext_online) return toast("Расширение в браузере не отвечает", true);
  const sites = q.sites.filter(s => (siteById(s) || {}).type === "ext");
  if(!sites.length) return toast("У очереди нет сайтов «в моём браузере»", true);
  const pub = await ext({type:"pubGet"}) || {};
  const ov = modal(`<div class="mh"><h3>📦 Пачкой на один сайт — «${esc(q.name)}»</h3>${closeX}</div>
    <div class="small muted">Откроется одна вкладка сайта; после публикации там же откроется следующий товар. Удобно, когда хотите выставить, например, 10 сумок только на Kleinanzeigen.</div>
    <div class="grid3"><label class="field">Сайт<select id="bSite">${sites.map(s => `<option value="${esc(s)}">${esc(siteName(s))}</option>`).join("")}</select></label>
      <label class="field">Сколько, шт<input id="bCount" type="number" min="1" value="${esc(store("bCount_" + q.id) || 10)}"></label>
      <label class="field">Пауза между товарами, сек<input id="bPause" type="number" min="0" value="${esc(pub.batchPause ?? 15)}"></label></div>
    <div class="row"><button class="go" id="bGo">▶ Выставить пачкой</button><button data-x>Отмена</button></div>`);
  $("#bGo", ov).onclick = async () => {
    const n = Number($("#bCount", ov).value) || 10; store("bCount_" + q.id, String(n));
    await ext({type:"pubSet", batchPause: Math.max(0, Number($("#bPause", ov).value) || 0)});
    const r = await ext({type:"batchStart", line: q.id, site: $("#bSite", ov).value, target: n}, 30000);
    if(!r || r.ok === false) return toast((r && r.error) || "Расширение не ответило", true);
    ov.remove(); toast("📦 Пачка запущена"); loadExtState();
  };
}

// ---------- настройки очереди ----------
function drawSet(){
  const box = $("#qSet"); if(!box) return;
  box.classList.toggle("hidden", !setOpen);
  $("#qSetBtn").classList.toggle("primary", setOpen);
  if(!setOpen) return;
  const q = qById(QID);
  const boardSites = Q.sites.filter(s => s.id !== "doninisklep");
  box.innerHTML = `<div class="card"><div class="mh row" style="margin-bottom:10px"><h3 style="margin:0;flex:1">⚙️ Настройки очереди «${esc(q.name)}»</h3><button class="ghost" id="qsClose">✕</button></div>
    <div class="grid3">
      <label class="field">Название<input id="qsName" value="${esc(q.name)}"></label>
      <label class="field">Шаблон текста<select id="qsTpl">${tplOpts(q.template)}</select></label>
      <label class="field">Цена по умолчанию, zł<input id="qsPrice" value="${esc(q.default_price || "")}"></label>
      <label class="field">${q.template === "phonecases" ? "Модель по умолчанию" : "Размер по умолчанию"}<input id="qsSize" value="${esc(q.default_size || "")}" placeholder="например 26*16 cm"></label>
      <label class="field">Где показывать<select id="qsGroup"><option value="main" ${q.group === "main" ? "selected" : ""}>вкладкой сверху</option><option value="more" ${q.group !== "main" ? "selected" : ""}>в «Ещё»</option></select></label>
    </div>
    <div class="row small" style="margin-top:8px"><button class="sm" id="qsMgr">✏️ Поправить текст шаблона в Donini Manager</button><button class="sm" id="qsPrev">👁 Как выглядит текст</button><span class="muted">Папка: ${esc(folderOf(q))}</span></div>
    ${q.id === "site" ? `<div id="wooBox" style="margin-top:14px"></div>` : `
    <div class="row" style="margin-top:14px"><b style="flex:1">На какие сайты выставлять</b><button class="sm" id="qsSitesPage">🧩 Все сайты и записи</button></div>
    <table id="qsSites" style="margin-top:6px"><tr><th style="width:36px"></th><th>Сайт</th><th>Запись (сценарий)</th><th>Бренд в названии</th><th></th></tr>
    ${boardSites.map(s => { const own = s.scenarios[q.id], gen = s.scenarios.default;
      return `<tr data-ss="${s.id}"><td><input type="checkbox" value="${s.id}" ${q.sites.includes(s.id) ? "checked" : ""}></td>
        <td><b>${esc(s.name)}</b>${s.enabled ? "" : ` <span class="small muted">(сайт выключен)</span>`}</td>
        <td class="small">${own ? `<span class="ok">✓ своя для этой очереди</span>` : gen ? `<span class="ok">✓ общая</span>` : `<span class="err">нет записи</span>`}</td>
        <td><button class="chip btn ${s.title_brand ? "on" : ""}" data-qbrand="${s.id}" title="Для этого сайта во всех очередях">${s.title_brand ? "🏷 с брендом" : "без бренда"}</button></td>
        <td class="acts"><button data-qrec="${s.id}">● ${own ? "Перезаписать" : "Записать свою"}</button></td></tr>`; }).join("")}</table>
    <div class="small muted" style="margin-top:6px">Галочка — выставлять эту очередь на сайт. Добавили сайт — товары, уже выставленные на других сайтах, пойдут и на него (без дублей).
      Бренд в названии — настройка сайта, действует для всех очередей; убрать бренд у одного товара — кнопка 🏷 в его строке.</div>`}
    <div class="row" style="margin-top:14px"><button class="primary" id="qsSave">Сохранить</button>
      <span class="spacer"></span>${q.group !== "main" || !["bags", "other", "sumki", "cases", "site"].includes(q.id) ? "" : ""}</div></div>`;
  $("#qsClose").onclick = () => { setOpen = false; drawSet(); };
  $("#qsMgr").onclick = () => openManager($("#qsTpl").value);
  $("#qsPrev").onclick = () => previewModal(q.id);
  const ss = $("#qsSitesPage"); if(ss) ss.onclick = () => go("sites");
  $$("[data-qbrand]", box).forEach(b => b.onclick = async () => { const s = siteById(b.dataset.qbrand);
    if(await act(() => post(`/api/site/${s.id}`, {title_brand: !s.title_brand}), !s.title_brand ? `${s.name}: бренд пишется в название` : `${s.name}: без бренда`)){ await refresh(); drawSet(); } });
  $$("[data-qrec]", box).forEach(b => b.onclick = () => recordModal(siteById(b.dataset.qrec), q.id));
  $("#qsSave").onclick = async () => {
    const body = {name: $("#qsName").value, template: $("#qsTpl").value, default_price: $("#qsPrice").value, default_size: $("#qsSize").value, group: $("#qsGroup").value};
    if($("#qsSites")) body.sites = $$("#qsSites input:checked").map(i => i.value);
    if(await act(() => post(`/api/queue/${q.id}/edit`, body), "Сохранено")){ setOpen = false; await refresh(); drawSet(); listSig = ""; loadList(true); }
  };
  if(q.id === "site") drawWoo();
}
async function previewModal(lid){
  const q = qById(lid);
  const ov = modal(`<div class="mh"><h3>Текст объявления — «${esc(q.name)}»</h3>${closeX}</div>
    <label class="field">Страна<select id="pvLang">${META.langs.map(l => `<option value="${l.code}">${l.code} — ${esc(l.name)}</option>`).join("")}</select></label>
    <pre id="pvText" class="card inset" style="white-space:pre-wrap;margin:0;font:inherit"></pre>`);
  const load = async () => { const r = await act(() => api(`/api/preview?line=${enc(lid)}&lang=${$("#pvLang", ov).value}&size=${enc(q.default_size || "")}&code=83278&price=${q.default_price || 0}`));
    if(r) $("#pvText", ov).textContent = `${r.title}\n\n${r.body}\n\nЦена: ${r.price} ${r.currency}`; };
  $("#pvLang", ov).onchange = load; load();
}
function openManager(tpl){ if(tpl){ store("plt_productType", tpl); MGR_TPL = tpl; } go("tpl"); }

// ---------- мой сайт: подключение (WooCommerce) ----------
async function drawWoo(){
  const box = $("#wooBox"); if(!box) return;
  let W; try{ W = await api("/api/woo/config"); }catch(e){ return; }
  const w = W.woo || {};
  box.innerHTML = `<h3>🌐 Подключение doninisklep.com</h3>
    <div class="small muted" style="margin-bottom:8px">Ключ: WordPress → WooCommerce → Настройки → Дополнительно → REST API → «Добавить ключ» (Чтение/Запись). Пароль приложения: Пользователи → Профиль → «Пароли приложений».
      В очереди сейчас ${W.left}, загружено ${W.done}${W.errors ? `, <span class="err">ошибок ${W.errors}</span>` : ""}.</div>
    <div class="grid3">
      <label class="field">Адрес сайта<input id="w_url" value="${esc(w.url || "")}" placeholder="https://doninisklep.com"></label>
      <label class="field">Consumer key<input id="w_ck" value="${esc(w.ck || "")}" placeholder="ck_..."></label>
      <label class="field">Consumer secret<input id="w_cs" value="${esc(w.cs || "")}" placeholder="cs_..."></label>
      <label class="field">Логин WordPress<input id="w_user" value="${esc(w.wp_user || "")}"></label>
      <label class="field">Пароль приложения<input id="w_pass" value="${esc(w.wp_pass || "")}" placeholder="xxxx xxxx xxxx xxxx"></label>
      <label class="field">Товар-образец: ссылка, ID или артикул<input id="w_tpl" value="${esc(w.template || "")}"></label>
      <label class="field">Публикация<select id="w_status"><option value="publish" ${w.status !== "draft" ? "selected" : ""}>сразу на сайт</option><option value="draft" ${w.status === "draft" ? "selected" : ""}>черновиком (проверю сам)</option></select></label>
      <label class="field">Пауза между товарами, сек<input id="w_pause" value="${esc(w.pause_sec || "10")}"></label>
    </div>
    <div id="wLists" class="grid3 hidden" style="margin-top:10px"></div><div id="wTplInfo" class="small" style="margin-top:6px"></div>
    <div class="row" style="margin-top:10px"><button id="wCheck">Проверить подключение</button><button class="primary" id="wSave">Сохранить подключение</button></div>`;
  let lists = null;
  const form = () => ({url: $("#w_url").value.trim(), ck: $("#w_ck").value.trim(), cs: $("#w_cs").value.trim(), wp_user: $("#w_user").value.trim(),
    wp_pass: $("#w_pass").value.trim(), status: $("#w_status").value, pause_sec: $("#w_pause").value.trim(), template: $("#w_tpl").value.trim(),
    ...(lists ? {category: $("#w_cat").value, brand_attr: $("#w_brand").value, size_attr: $("#w_size").value} : {})});
  $("#wCheck").onclick = async () => {
    const r = await act(() => post("/api/woo/check", form())); if(!r) return;
    lists = r;
    const opt = (arr, cur, empty) => `<option value="">${empty}</option>` + arr.map(x => `<option value="${x.id}" ${String(x.id) === String(cur || "") ? "selected" : ""}>${esc(x.name)}${x.count != null ? ` (${x.count})` : ""}</option>`).join("");
    const guess = (re, cur) => cur || ((r.attributes.find(a => re.test(a.name)) || {}).id || "");
    $("#wLists").innerHTML = `<label class="field">Категория<select id="w_cat">${opt(r.categories, w.category, "— без категории —")}</select></label>
      <label class="field">Атрибут «Бренд»<select id="w_brand">${opt(r.attributes, guess(/marka|brand|бренд/i, w.brand_attr), "— не ставить —")}</select></label>
      <label class="field">Атрибут «Размер»<select id="w_size">${opt(r.attributes, guess(/rozmiar|wymiar|size|размер/i, w.size_attr), "— не ставить —")}</select></label>`;
    $("#wLists").classList.remove("hidden");
    $("#wTplInfo").innerHTML = r.template ? `✅ Образец: <b>${esc(r.template.name)}</b> (артикул ${esc(r.template.sku || "—")}, цена ${esc(r.template.price || "—")})` : "";
    toast("✅ Сайт подключён. Выберите категорию и атрибуты и нажмите «Сохранить подключение»");
  };
  $("#wSave").onclick = () => act(() => post("/api/woo/config", form()), "Подключение сохранено");
}

// ---------- карточка товара ----------
async function cardModal(pid){
  let d; try{ d = await api(`/api/product/${pid}/card`); }catch(e){ return toast(e.message, true); }
  let sel = [...d.photos], off = [...d.others];
  const ST = {done:"✓ выставлен", error:"ошибка", pending:"ждёт", running:"выставляется", skipped:"пропущен"};
  const ov = modal("", "w2"), box = $(".modal", ov);
  const ph = (list, isOff) => list.map((x, i) => `<div class="ph ${!isOff && i === 0 ? "main" : ""}" draggable="${!isOff}" data-i="${i}" data-off="${isOff ? 1 : 0}">
      <img loading="lazy" src="/api/thumb?path=${enc(x)}">
      ${isOff && d.qc_bad && d.qc_bad[x] ? `<span class="why">🧹 ${esc(d.qc_bad[x])}</span>` : ""}
      ${isOff ? `<span class="n" data-on="${i}" style="cursor:pointer">+ вернуть</span>` : `<span class="n">${i === 0 ? "⭐ главное" : i + 1}</span>
      <div class="bt"><button data-ph="left" title="Левее">◀</button><button data-ph="main" title="Главным">⭐</button><button data-ph="right" title="Правее">▶</button><button data-ph="off" title="Не использовать">✕</button></div>`}</div>`).join("");
  const isCase = () => (d.lines.find(l => l.id === (($("#cdLine", box) || {}).value || d.line)) || {}).template === "phonecases" || d.template === "phonecases";
  const keep = () => $("#cdBrand", box) ? {b: $("#cdBrand", box).value, s: $("#cdSize", box).value, p: $("#cdPrice", box).value, l: $("#cdLine", box).value, t: $("#cdTpl", box).value, wb: $("#cdWithBrand", box).checked} : null;
  const draw = () => {
    const k = keep();
    box.innerHTML = `<div class="mh"><h3><span class="code">${esc(d.code)}</span> ${esc(d.name)}</h3>${closeX}</div>
    <div class="grid2" style="gap:18px;align-items:start">
      <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
        <b>Фото в объявлении: ${sel.length} <span class="small muted" style="font-weight:400">— нажмите, чтобы открыть крупно; перетаскивайте мышкой; первое — главное</span></b>
        <div class="phgrid" id="cpSel">${ph(sel, false) || `<span class="warn">Нет фото — верните ниже</span>`}</div>
        ${off.length ? `<b class="small muted">Не используются — «+ вернуть», чтобы снова поставить в объявление:</b><div class="phgrid off">${ph(off, true)}</div>` : ""}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label class="field">Очередь<select id="cdLine">${d.lines.map(l => `<option value="${esc(l.id)}" ${l.id === d.line ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
        <label class="field">Шаблон текста<select id="cdTpl"><option value="">как у очереди</option>${d.types.map(t => `<option value="${esc(t.id)}" ${t.id === d.template_own ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
        <label class="field">Бренд ${d.brand_manual ? "" : `<span class="muted">(найден автоматически)</span>`}<input id="cdBrand" value="${esc(d.brand)}"></label>
        <label class="check small"><input type="checkbox" id="cdWithBrand" ${d.no_brand ? "" : "checked"}> выгружать с брендом</label>
        <div class="grid2" style="grid-template-columns:1fr 110px;gap:10px"><label class="field">${isCase() ? "📱 Модель телефона" : "Размер"}<input id="cdSize" value="${esc(d.size)}"></label>
          <label class="field">Цена, zł<input id="cdPrice" value="${esc(d.price ?? "")}"></label></div>
        <div class="field">Сайты этого товара<div>${d.sites.map(x => x.status === "done"
          ? `<a class="chip done" ${x.url ? `href="${esc(x.url)}" target="_blank"` : ""}>${esc(x.name)} ✓${x.url ? " ↗" : ""}</a>`
          : `<label class="chip ${x.status}" style="cursor:pointer" title="${esc(x.error || "")}"><input type="checkbox" data-site="${esc(x.id)}" ${x.status !== "skipped" ? "checked" : ""}> ${esc(x.name)} · ${ST[x.status] || x.status}</label>`).join("") || `<span class="muted small">нет</span>`}</div></div>
        <div class="row"><button data-m="texts">✏️ Тексты по странам</button>${d.folder_exists ? `<button data-m="folder">📂 Папка</button>` : ""}
          ${d.locked ? `<button data-m="reset" title="Все фото из папки, как было">↺ Фото как в папке</button>` : ""}</div>
      </div>
    </div>
    <div class="row"><button class="primary" data-m="save">Сохранить</button><button data-x>Отмена</button></div>`;
    if(k){ $("#cdBrand", box).value = k.b; $("#cdSize", box).value = k.s; $("#cdPrice", box).value = k.p; $("#cdLine", box).value = k.l; $("#cdTpl", box).value = k.t; $("#cdWithBrand", box).checked = k.wb; }
  };
  draw();
  const build = () => [...sel.map((x, k) => ({path: x, off: false, main: k === 0})), ...off.map(x => ({path: x, off: true}))];
  box.addEventListener("click", async e => {
    const on = e.target.closest("[data-on]"); if(on){ sel.push(off.splice(+on.dataset.on, 1)[0]); return draw(); }
    const img = e.target.closest(".ph img");
    if(img){
      const el = img.closest(".ph"), isOff = el.dataset.off === "1";
      return lightbox(build(), (isOff ? sel.length : 0) + +el.dataset.i, (it, a) => {
        if(a === "main") sel.unshift(sel.splice(sel.indexOf(it.path), 1)[0]);
        if(a === "off") off.push(sel.splice(sel.indexOf(it.path), 1)[0]);
        if(a === "on") sel.push(off.splice(off.indexOf(it.path), 1)[0]);
        draw(); const items = build(); return {items, index: items.findIndex(x => x.path === it.path)};
      });
    }
    const b = e.target.closest("[data-ph]");
    if(b){ const i = +b.closest(".ph").dataset.i;
      if(b.dataset.ph === "left" && i > 0) [sel[i - 1], sel[i]] = [sel[i], sel[i - 1]];
      if(b.dataset.ph === "right" && i < sel.length - 1) [sel[i + 1], sel[i]] = [sel[i], sel[i + 1]];
      if(b.dataset.ph === "main") sel.unshift(sel.splice(i, 1)[0]);
      if(b.dataset.ph === "off") off.push(sel.splice(i, 1)[0]);
      return draw(); }
    const m = e.target.closest("[data-m]"); if(!m) return;
    if(m.dataset.m === "folder") return post("/api/open_folder", {path: d.folder});
    if(m.dataset.m === "texts"){ ov.remove(); return textsModal(pid); }
    if(m.dataset.m === "reset"){ await act(() => post(`/api/product/${pid}`, {photos_reset: true}), "Фото — как в папке"); ov.remove(); listSig = ""; return loadList(true); }
    if(m.dataset.m === "save"){
      if(!sel.length) return toast("Оставьте хотя бы одно фото", true);
      const skip = {}; $$("[data-site]", box).forEach(c => skip[c.dataset.site] = c.checked);
      const body = {template: $("#cdTpl", box).value, no_brand: !$("#cdWithBrand", box).checked, brand: $("#cdBrand", box).value, size: $("#cdSize", box).value,
        price: $("#cdPrice", box).value, line: $("#cdLine", box).value, skip_sites: skip};
      if(sel.join("|") !== d.photos.join("|") || off.length !== d.others.length) body.photos = sel;
      if(await act(() => post(`/api/product/${pid}`, body), "✓ Карточка сохранена")){ ov.remove(); listSig = ""; loadList(true); refresh(); }
    }
  });
  box.addEventListener("change", e => { if(e.target.id === "cdLine") draw(); });
  let dragI = null;
  box.addEventListener("dragstart", e => { const p = e.target.closest('.ph[data-off="0"]'); if(p) dragI = +p.dataset.i; });
  box.addEventListener("dragover", e => { if(dragI !== null && e.target.closest('.ph[data-off="0"]')) e.preventDefault(); });
  box.addEventListener("drop", e => { const p = e.target.closest('.ph[data-off="0"]'); if(p && dragI !== null){ e.preventDefault(); e.stopPropagation(); sel.splice(+p.dataset.i, 0, sel.splice(dragI, 1)[0]); dragI = null; draw(); } });
}
async function quickPhotos(pid){
  let d; try{ d = await api(`/api/product/${pid}/card`); }catch(e){ return; }
  let sel = [...d.photos], off = [...d.others];
  if(!sel.length && !off.length) return toast("У товара нет фото", true);
  const build = () => [...sel.map((x, k) => ({path: x, off: false, main: k === 0})), ...off.map(x => ({path: x, off: true}))];
  lightbox(build(), 0, (it, a) => {
    if(a === "main") sel.unshift(sel.splice(sel.indexOf(it.path), 1)[0]);
    if(a === "off"){ if(sel.length <= 1){ toast("Должно остаться хотя бы одно фото", true); return null; } off.push(sel.splice(sel.indexOf(it.path), 1)[0]); }
    if(a === "on") sel.push(off.splice(off.indexOf(it.path), 1)[0]);
    post(`/api/product/${pid}`, {photos: sel}).then(() => { toast(a === "off" ? "Фото убрано из объявления" : a === "on" ? "Фото возвращено" : "Главное фото выбрано"); listSig = ""; loadList(true); });
    const items = build(); return {items, index: items.findIndex(x => x.path === it.path)};
  });
}
async function textsModal(pid){
  let d; try{ d = await api(`/api/product/${pid}/texts`); }catch(e){ return toast(e.message, true); }
  if(!d.langs.length) return toast("У этого товара нет сайтов", true);
  const ov = modal(`<div class="mh"><h3>✏️ Текст товара <span class="code">${esc(d.code)}</span></h3>${closeX}</div>
    <div class="small muted">Так текст вставится на сайты. Правка — только для этого товара. «↺ По шаблону» — вернуть текст шаблона.</div>
    ${d.langs.map(x => `<div class="card inset" data-lang="${x.lang}">
      <div class="row"><b>${esc(x.country)}</b><span class="small muted">${esc(x.sites.join(", "))}</span>${x.edited ? `<span class="badge warn">изменён</span>` : ""}<span class="spacer"></span><button class="sm" data-reset="${x.lang}">↺ По шаблону</button></div>
      <label class="field" style="margin-top:8px">Название<input data-k="title" value="${esc(x.title)}"></label>
      <label class="field" style="margin-top:8px">Описание<textarea data-k="body" rows="6">${esc(x.body)}</textarea></label></div>`).join("")}
    <div class="row"><button class="primary" id="txSave">Сохранить</button><button data-x>Отмена</button></div>`, "w2");
  ov.addEventListener("click", e => { const r = e.target.closest("[data-reset]"); if(!r) return;
    const x = d.langs.find(y => y.lang === r.dataset.reset), c = $(`[data-lang="${x.lang}"]`, ov);
    $('[data-k="title"]', c).value = x.auto_title; $('[data-k="body"]', c).value = x.auto_body; });
  $("#txSave", ov).onclick = async () => {
    const body = {}; $$("[data-lang]", ov).forEach(c => body[c.dataset.lang] = {title: $('[data-k="title"]', c).value, body: $('[data-k="body"]', c).value});
    if(await act(() => post(`/api/product/${pid}/texts`, body), "Текст сохранён")){ ov.remove(); listSig = ""; loadList(true); }
  };
}

// ---------- загрузка папок перетаскиванием ----------
const UP_EXT = /\.(jpe?g|png|webp|heic|heif|bmp|gif|zip|txt)$/i;
async function collectDropped(dt){
  const out = [];
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  const walk = async (entry, path) => {
    if(entry.isFile){ const f = await new Promise((res, rej) => entry.file(res, rej)); out.push({file: f, rel: path + f.name}); }
    else if(entry.isDirectory){ const reader = entry.createReader(); let batch;
      do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); for(const e of batch) await walk(e, path + entry.name + "/"); } while(batch.length); }
  };
  if(entries.length){ for(const e of entries) await walk(e, ""); } else for(const f of dt.files || []) out.push({file: f, rel: f.name});
  return out;
}
let pickLine = null;
function pickFolder(line){ pickLine = line; $("#dirPick").value = ""; $("#dirPick").click(); }
$("#dirPick").onchange = (e) => { const files = [...e.target.files].map(f => ({file: f, rel: f.webkitRelativePath || f.name})); if(pickLine && files.length) uploadTo(pickLine, files); };
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => e.preventDefault());
async function uploadTo(line, items){
  items = items.filter(x => UP_EXT.test(x.rel));
  const redraw = () => { updateQueue(); if(PAGES.add.redraw) PAGES.add.redraw(); };
  if(!items.length){ UP[line] = {msg: "Не нашёл фото в перетащенном", err: true}; redraw(); return; }
  const u = UP[line] = {done: 0, total: items.length, msg: ""}; redraw();
  try{
    const {token} = await post("/api/upload/begin", {line});
    let i = 0;
    const worker = async () => { while(i < items.length){ const it = items[i++];
      const r = await fetch(`/api/upload/file?token=${token}&rel=${enc(it.rel)}`, {method:"POST", body: it.file});
      if(!r.ok) throw new Error("не загрузился " + it.rel);
      u.done++; if(u.done % 5 === 0 || u.done === u.total) redraw(); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const r = await post("/api/upload/end", {token});
    u.msg = `✓ Добавлено товаров: ${r.folders}${r.files ? ` (+ ${r.files} отдельных фото)` : ""}. Через пару секунд появятся в очереди.`;
  }catch(e){ u.msg = "⚠️ " + e.message; u.err = true; }
  u.total = 0; redraw(); setTimeout(() => { listSig = ""; loadList(true); refresh(); }, 2500);
  setTimeout(() => { if(UP[line] === u){ delete UP[line]; redraw(); } }, 15000);
}

// ---------- новая очередь ----------
$("#newQBtn").onclick = () => {
  const ov = modal(`<div class="mh"><h3>＋ Новая очередь</h3>${closeX}</div>
    <label class="field">Название (так же назовётся папка в «Очередь»)<input id="nqName" placeholder="Ремни"></label>
    <div class="field">На какие сайты</div><div class="checks" id="nqSites">${Q.sites.filter(s => s.id !== "doninisklep").map(s => `<label><input type="checkbox" value="${s.id}">${esc(s.name)}</label>`).join("")}</div>
    <label class="field">Где показывать<select id="nqGroup"><option value="main">вкладкой сверху</option><option value="more">в «Ещё»</option></select></label>
    <div class="small muted">Шаблон текста подберётся по названию — поменять можно в «⚙️ Настройки очереди». Сценарий сайта берётся общий; если нужна другая категория — запишите свой в Настройки → Сайты.
      Можно и просто создать папку в «Очередь» — программа сама сделает из неё очередь.</div>
    <div class="row"><button class="primary" id="nqGo">Создать</button><button data-x>Отмена</button></div>`);
  $("#nqName", ov).focus();
  $("#nqGo", ov).onclick = async () => {
    const r = await act(() => post("/api/queue_new", {name: $("#nqName", ov).value, sites: $$("#nqSites input:checked", ov).map(i => i.value), group: $("#nqGroup", ov).value}));
    if(r){ ov.remove(); toast(`Очередь «${r.line.name}» создана`); META = await api("/api/meta").catch(() => META); await refresh(); go("q:" + r.line.id); }
  };
};
