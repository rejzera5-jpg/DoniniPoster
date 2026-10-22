// «Исправить объявления»: поменять название в уже выставленных объявлениях (бот открывает каждое и сохраняет новое).
let ED = {prev: null, init: false};
PAGES.edits = { show(){ drawEdits(); }, refresh(){} };
setInterval(() => { if(page === "edits") edStatus(); else edBadge(); }, 8000);
async function edBadge(){ try{ const r = await api("/api/edit/status"); const n = $("#nEdits"); n.textContent = r.left || ""; n.classList.toggle("hidden", !r.left); }catch(e){} }
function drawEdits(){
  const y = new Date(Date.now() - 86400000), ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sites = Q.sites.filter(s => s.type === "ext" || s.type === "manual");
  $("#page-edits").innerHTML = `<h1>Исправить объявления</h1>
    <div class="card"><div class="small muted">Бот откроет каждое уже выставленное объявление и поменяет название. Один раз на каждый сайт нужно записать, как исправлять
      (открыть объявление → «Редактировать» → поле названия → кнопка «Название» на панели → «Сохранить»). Исправления идут через расширение вперемешку с очередью — очередь не останавливается.</div>
      <div class="field" style="margin-top:12px">На каких сайтах</div>
      <div class="checks">${sites.map(s => `<label><input type="checkbox" data-es="${esc(s.id)}" ${/vatera/.test(s.id) ? "checked" : ""}>${esc(s.name)}</label>`).join("")}</div>
      <div class="grid3" style="margin-top:12px">
        <label class="field">Выставлены (дата)<input id="edDate" type="date" value="${ymd(y)}"></label>
        <label class="field">Было в названии<input id="edFind" value="${esc(store("edFind") || "Női és férfi bőr táska hátizsák")}"></label>
        <label class="field">Новое название (код товара останется)<input id="edRepl" value="${esc(store("edRepl") || "")}" placeholder="например: Női bőr táska"></label>
      </div>
      <div class="row" style="margin-top:12px"><button id="edPrevBtn">🔎 Посмотреть, что исправится</button><span class="spacer"></span><span id="edStatus" class="small muted"></span></div></div>
    <div id="edPrev"></div>
    <div class="card"><div class="row">
      <button data-e="test" title="Бот исправит первое объявление и остановится перед сохранением — нажмёте сами">🧪 Проверить на одном</button>
      <button class="primary" data-e="start">▶ Исправить все</button><button data-e="pause" id="edPause">⏸ Пауза</button>
      <span class="spacer"></span><button class="danger" data-e="cancel">Отменить исправление</button></div>
      <div class="small muted" style="margin-top:8px">Чтобы исправления шли, должна работать хотя бы одна очередь (▶ Старт) — или запустите «📦 Пачкой на один сайт».</div></div>`;
  $("#edFind").onchange = e => store("edFind", e.target.value); $("#edRepl").onchange = e => store("edRepl", e.target.value);
  $("#edPrevBtn").onclick = edPreview;
  $$("[data-es]").forEach(c => c.onchange = edPreview);
  $("#page-edits").onclick = async e => {
    const b = e.target.closest("[data-e]"); if(b) return edAct(b.dataset.e);
    const sv = e.target.closest("[data-esave]"); if(sv) return act(() => post("/api/edit/site", {site: sv.dataset.esave, edit_url: $(`[data-eurl="${sv.dataset.esave}"]`).value}), "Сохранено");
    const rc = e.target.closest("[data-erec]"); if(rc){
      const sid = rc.dataset.erec; await post("/api/edit/site", {site: sid, edit_url: $(`[data-eurl="${sid}"]`).value}).catch(() => {});
      const ov = modal(`<div class="mh"><h3>● Записать исправление — ${esc(siteName(sid))}</h3>${closeX}</div>
        <ol class="steps small"><li>Откроется одно из выставленных объявлений (или страница из поля).</li><li>Откройте редактирование → кликните в поле названия → очистите его → кнопка «Название» на панели Donini.</li>
          <li>«Следующий клик = Опубликовать» → кнопка «Сохранить» на сайте → «Готово».</li><li>Если объявление нужно сначала найти — впишите код кнопкой «Код» в поиск.</li></ol>
        <div class="row"><button class="primary" id="erGo">● Начать запись</button><button data-x>Отмена</button></div>`);
      $("#erGo", ov).onclick = async () => { ov.remove(); const r = await ext({type: "record", site: sid, line: "__edit"}, 30000); (!r || r.ok === false) ? toast((r && r.error) || "Расширение не ответило", true) : toast("Запись началась в браузере"); };
    }
  };
  edPreview();
}
const edBody = () => ({sites: $$("[data-es]").filter(c => c.checked).map(c => c.dataset.es), date: $("#edDate").value, find: $("#edFind").value, replace: $("#edRepl").value});
async function edPreview(){
  try{ ED.prev = await post("/api/edit/preview", edBody()); }catch(e){ return; }
  $("#edPrev").innerHTML = ED.prev.sites.length ? ED.prev.sites.map(x => `<div class="card"><div class="row"><b>${esc(x.name)}: ${x.count} объявлений</b>
      ${x.no_id ? `<span class="small warn">у ${x.no_id} нет номера объявления — бот найдёт их по коду через поиск, если так записано</span>` : ""}<span class="spacer"></span>
      ${x.edit_steps ? `<span class="small ok">исправление записано: ${x.edit_steps} шагов</span>` : `<span class="small warn">исправление ещё не записано</span>`}
      <button class="sm" data-erec="${esc(x.site)}">● ${x.edit_steps ? "Перезаписать" : "Записать"} исправление</button></div>
    <div class="row" style="margin-top:8px"><label class="field" style="flex:1">Страница объявления для исправления ({ad_id} — номер объявления, {code} — код товара)
      <input data-eurl="${esc(x.site)}" value="${esc(x.edit_url || "")}" placeholder="${x.site === "vatera" ? "https://www.vatera.hu/item/mod/?id={ad_id}" : "страница «Мои объявления», где есть поиск"}"></label>
      <button data-esave="${esc(x.site)}" style="align-self:flex-end">💾</button></div>
    ${x.samples.some(s => s.title) ? `<div class="small muted" style="margin-top:6px">Пример: ${x.samples.slice(0, 3).map(s => `<br>${esc(s.code)} → «${esc(s.title)}»`).join("")}</div>` : ""}</div>`).join("")
    : `<div class="card muted small">Нет выставленных объявлений за эту дату на выбранных сайтах.</div>`;
  edStatus();
}
async function edStatus(){
  if(!$("#edStatus")) return;
  try{ const r = await api("/api/edit/status");
    $("#edStatus").innerHTML = (r.left ? `<b>Осталось: ${r.left}</b>${r.errors ? `, <span class="warn">с ошибкой: ${r.errors}</span>` : ""} · исправлено: ${r.done}${r.paused ? ` · <span class="warn">на паузе</span>` : ""}` : (r.done ? `<span class="ok">Исправлено: ${r.done}</span>` : "")) +
      (r.manual && r.manual.length ? `<br><span class="warn">Исправить вручную (нет номера объявления): ${esc(r.manual.join(", "))}</span>` : "");
    $("#edPause").textContent = r.paused ? "▶ Продолжить" : "⏸ Пауза";
    const n = $("#nEdits"); n.textContent = r.left || ""; n.classList.toggle("hidden", !r.left);
  }catch(e){}
}
async function edAct(a){
  if(a === "pause"){ const r = await api("/api/edit/status"); await act(() => post("/api/edit/pause", {paused: !r.paused})); return edStatus(); }
  if(a === "cancel"){ if(!confirm("Снять все задания исправления? Объявления останутся как есть.")) return; await act(() => post("/api/edit/cancel"), "Исправление отменено"); return edStatus(); }
  if(!$("#edRepl").value.trim()) return toast("Впишите новое название", true);
  if(a === "start"){
    await edPreview(); const n = ED.prev ? ED.prev.sites.reduce((s, x) => s + x.count, 0) : 0;
    if(!n) return toast("Не найдено объявлений для исправления", true);
    if(!confirm(`Исправить название в ${n} объявлениях?`)) return;
    await act(() => post("/api/edit/start", edBody()), r => `✏️ В работе: ${r.count}. Исправления идут, пока работает очередь`);
  }
  if(a === "test"){
    const r = await act(() => post("/api/edit/start", {...edBody(), test: true}));
    if(r) modal(`<div class="mh"><h3>🧪 Проверка на одном</h3>${closeX}</div><div>Бот откроет первое объявление (по одному на каждый выбранный сайт), впишет новое название и <b>остановится перед сохранением</b> — даже в режиме «программа сама».
      Проверьте, что это редактирование нужного объявления и название новое, и нажмите подсвеченную кнопку сами. Пока вы не нажмёте, следующий товар очереди ждёт.</div><div class="row"><button class="primary" data-x>Понятно</button></div>`);
  }
  edStatus();
}
edBadge();
