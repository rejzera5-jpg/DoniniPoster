// «Сайты и сценарии»: какой сайт в какой очереди, какая запись (сценарий) используется, бренд в названии, настройки сайта.
// Записанные сценарии хранятся в программе: data\sites\<сайт>.json — не в браузере, поэтому при смене браузера они остаются.
let SITE_OPEN = null;
PAGES.sites = { show(){ drawSitesPage(); }, refresh(){ if(!editing($("#page-sites")) && !document.querySelector(".ov")) drawSitesPage(true); } };
const TYPE_TXT = {ext: "в моём браузере (расширение)", plugin: "в программе, без браузера", scenario: "браузер программы, в фоне", manual: "в моём браузере"};
const CURRENCIES = ["", "EUR", "PLN", "RON", "HUF", "CZK"];
const scName = (k) => k === "default" ? "общий (все очереди)" : k === "__edit" ? "✏️ исправление названия" : ((qById(k) || {}).name || k);
let ROOT_PATH = "";
api("/api/app/paths").then(p => { ROOT_PATH = p.root; }).catch(() => {});

function cellFor(s, q){
  const inQ = q.sites.includes(s.id), own = s.scenarios[q.id], gen = s.scenarios.default;
  if(!inQ) return `<td class="mx off" data-cell="add" data-q="${q.id}" title="«${esc(s.name)}» не выставляется для «${esc(q.name)}». Нажмите, чтобы добавить">＋</td>`;
  if(own) return `<td class="mx ok" data-cell="has" data-q="${q.id}" title="Своя запись для «${esc(q.name)}»: ${own} шагов${s.has_publish[q.id] ? "" : " (не отмечена кнопка «Опубликовать»)"}">✓ своя</td>`;
  if(gen) return `<td class="mx ok" data-cell="has" data-q="${q.id}" title="Используется общая запись: ${gen} шагов">✓ общая</td>`;
  return `<td class="mx no" data-cell="rec" data-q="${q.id}" title="Сайт отмечен, но запись не сделана — товары на него не пойдут. Нажмите, чтобы записать">● записать</td>`;
}
function drawSitesPage(soft){
  const box = $("#page-sites"); if(!box || page !== "sites") return;
  const qs = boardQueues().slice().sort((a, b) => (a.group !== "main") - (b.group !== "main"));
  const boards = Q.sites.filter(s => s.type !== "plugin"), plug = Q.sites.filter(s => s.type === "plugin");
  const open = SITE_OPEN && siteById(SITE_OPEN);
  const html = `<div class="row"><h1>Сайты и сценарии</h1><span class="spacer"></span>
      <button id="scFolder" title="Открыть папку, где лежат записанные сценарии">📂 Где хранятся записи</button><button class="primary" id="addSite">＋ Добавить сайт</button></div>
    <div class="banner info"><div class="t"><b>Записи (сценарии) хранятся в самой программе</b> — в папке <code>data\\sites</code>, по одному файлу на сайт. Браузер их не хранит:
      при смене браузера или переносе на другой компьютер (файлом переноса) записи остаются. В таблице видно, какая запись работает для каждой очереди.</div></div>
    <div class="card" style="overflow-x:auto">
      <table class="matrix"><tr><th>Сайт</th><th>Вкл</th><th title="Писать бренд товара в название объявления на этом сайте">Бренд в названии</th>${qs.map(q => `<th class="mxh">${esc(q.name)}</th>`).join("")}<th></th></tr>
      ${boards.map(s => `<tr data-site="${s.id}" class="${SITE_OPEN === s.id ? "sel" : ""}">
        <td><b>${esc(s.name)}</b><div class="small muted">${esc(s.lang)}${s.today ? ` · сегодня ${s.today}` : ""}${s.type === "scenario" ? " · в фоне" : ""}</div></td>
        <td><input type="checkbox" data-f="enabled" ${s.enabled ? "checked" : ""} title="${s.enabled ? "Сайт включён" : "Сайт выключен — на него ничего не выставляется"}"></td>
        <td><button class="chip btn ${s.title_brand ? "on" : ""}" data-brand title="Нажмите, чтобы переключить">${s.title_brand ? "🏷 с брендом" : "без бренда"}</button></td>
        ${qs.map(q => cellFor(s, q)).join("")}
        <td class="acts"><button data-sa="login" title="Открыть сайт в браузере, чтобы войти">🔑 Войти</button><button data-sa="open" class="${SITE_OPEN === s.id ? "primary" : ""}" title="Все настройки сайта">⚙️</button></td></tr>`).join("")}
      </table>
      <div class="row small muted" style="margin-top:10px"><span><b class="ok">✓ своя</b> — запись именно для этой очереди</span><span><b class="ok">✓ общая</b> — общая запись сайта</span>
        <span><b class="err">● записать</b> — сайт отмечен, но записи нет</span><span><b>＋</b> — сайт для очереди не выбран (нажмите, чтобы добавить)</span></div>
      ${plug.map(s => `<div class="row" style="margin-top:10px"><b>${esc(s.name)}</b><span class="small muted">— очередь «Мой сайт», загрузка в программе без браузера, запись не нужна.</span>
        <button class="sm" data-goq="site">Открыть «Мой сайт»</button></div>`).join("")}
    </div>
    ${open ? `<div class="card" data-site="${open.id}"><div class="row" style="margin-bottom:10px"><h3 style="margin:0;flex:1">⚙️ ${esc(open.name)}</h3><span class="small muted">${esc(TYPE_TXT[open.type] || open.type)}</span><button class="ghost" data-sa="open">✕</button></div>${siteDetail(open)}</div>` : ""}`;
  if(soft && box.__h === html) return;
  box.innerHTML = html; box.__h = html;
  $("#addSite").onclick = addSiteModal;
  $("#scFolder").onclick = () => post("/api/open_folder", {path: (ROOT_PATH || "") + "\\data\\sites"});
  box.onchange = async e => {
    const tr = e.target.closest("[data-site]"), f = e.target.dataset.f; if(!tr || !f) return;
    let v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if(e.target.type === "number") v = Number(String(v).replace(",", "."));
    if(await act(() => post(`/api/site/${tr.dataset.site}`, {[f]: v}), "Сохранено")) refresh();
  };
  box.onclick = async e => {
    const g = e.target.closest("[data-goq]"); if(g) return go("q:" + g.dataset.goq);
    const tr = e.target.closest("[data-site]"); if(!tr) return;
    const s = siteById(tr.dataset.site);
    if(e.target.closest("[data-brand]")){ if(await act(() => post(`/api/site/${s.id}`, {title_brand: !s.title_brand}), !s.title_brand ? `${s.name}: бренд пишется в название` : `${s.name}: без бренда`)) refresh(); return; }
    const c = e.target.closest("[data-cell]");
    if(c){ const q = qById(c.dataset.q);
      if(c.dataset.cell === "add"){ if(!confirm(`Выставлять «${q.name}» на ${s.name}?`)) return;
        if(await act(() => post(`/api/queue/${q.id}/edit`, {sites: [...q.sites, s.id]}), `${s.name} добавлен в «${q.name}»`)){ refresh(); if(!s.scenarios[q.id] && !s.scenarios.default) recordModal(s, q.id); } return; }
      if(c.dataset.cell === "rec") return recordModal(s, q.id);
      const k = s.scenarios[q.id] ? q.id : "default";
      const v = await choose(`${s.name} → «${q.name}»`, `Используется ${s.scenarios[q.id] ? "своя запись этой очереди" : "общая запись сайта"} (${s.scenarios[k]} шагов).`,
        [["steps", "Посмотреть шаги"], ["rec", s.scenarios[q.id] ? "● Перезаписать" : "● Записать свою для этой очереди"], ["off", "Не выставлять сюда"], ["", "Закрыть"]]);
      if(v === "steps") stepsModal(s.id, k);
      if(v === "rec") startRecord(s, q.id);
      if(v === "off" && await act(() => post(`/api/queue/${q.id}/edit`, {sites: q.sites.filter(x => x !== s.id)}), `${s.name} убран из «${q.name}»`)) refresh();
      return; }
    const b = e.target.closest("[data-sa]"); if(!b) return;
    const a = b.dataset.sa;
    if(a === "open"){ SITE_OPEN = SITE_OPEN === s.id ? null : s.id; box.__h = ""; drawSitesPage(); if(SITE_OPEN) setTimeout(() => { const el = $("#page-sites > .card[data-site]"); if(el) el.scrollIntoView({behavior: "smooth"}); }, 50); return; }
    if(a === "login"){ if(s.type === "scenario") return act(() => post(`/api/site/${s.id}/open`), "Окно браузера программы открыто — войдите в аккаунт");
      if(!Q.ext_online) return toast("Расширение не отвечает — сначала исправьте это (сообщение вверху)", true);
      await ext({type: "openTab", url: s.start_url}); return toast("Сайт открыт в браузере — войдите в аккаунт"); }
    if(a === "rec") return recordModal(s, null);
    if(a === "recline") return startRecord(s, b.dataset.line);
    if(a === "steps") return stepsModal(s.id, b.dataset.line);
    if(a === "test") return act(() => post(`/api/site/${s.id}/test`, {line: b.dataset.line}), "Тест запущен — программа заполнит форму и остановится перед «Опубликовать»");
    if(a === "delsc"){ if(!confirm(`Удалить запись «${scName(b.dataset.line)}» для ${s.name}?`)) return;
      const full = await api(`/api/site/${s.id}`); delete full.scenarios[b.dataset.line];
      if(await act(() => post(`/api/site/${s.id}`, {scenarios: full.scenarios}), "Запись удалена")) refresh(); }
    if(a === "del"){ if(!confirm(`Удалить сайт ${s.name} и все его записи?`)) return; if(await act(() => api(`/api/site/${s.id}`, {method: "DELETE"}), "Сайт удалён")){ SITE_OPEN = null; refresh(); } }
  };
}
function siteDetail(s){
  const sc = Object.entries(s.scenarios).filter(([k, n]) => n);
  const langOpts = META.langs.map(l => `<option value="${l.code}" ${l.code === s.lang ? "selected" : ""}>${l.code} — ${esc(l.name)}</option>`).join("");
  return `<div class="card inset">
    <div class="grid3">
      <label class="field">Название<input data-f="name" value="${esc(s.name)}"></label>
      <label class="field">Адрес сайта<input data-f="start_url" value="${esc(s.start_url)}"></label>
      <label class="field">Язык текстов<select data-f="lang">${langOpts}</select></label>
      <label class="field">Валюта<select data-f="currency">${CURRENCIES.map(c => `<option value="${c}" ${c === (s.currency || "") ? "selected" : ""}>${c || "по стране"}</option>`).join("")}</select></label>
      ${s.type === "plugin" ? "" : `<label class="field">Как выставлять<select data-f="type"><option value="ext" ${s.type === "ext" ? "selected" : ""}>в моём браузере — расширение (рекомендуется)</option><option value="scenario" ${s.type === "scenario" ? "selected" : ""}>браузер программы, в фоне</option></select></label>`}
      <label class="field">Максимум фото<input type="number" data-f="max_photos" value="${s.max_photos ?? ""}"></label>
      <label class="field">Лимит объявлений в день<input type="number" data-f="daily_limit" value="${s.daily_limit ?? ""}"></label>
      ${s.type === "scenario" ? `<label class="field">Пауза между объявлениями, мин<input type="number" step="0.5" data-f="min_interval_min" value="${s.min_interval_min ?? ""}"></label>` : ""}
      <label class="field">Пробелов после названия<input type="number" min="0" max="10" data-f="title_spaces" value="${s.title_spaces || 0}"></label>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="check"><input type="checkbox" data-f="title_brand" ${s.title_brand ? "checked" : ""}> писать бренд в название</label>
      ${s.type === "scenario" ? `<label class="check"><input type="checkbox" data-f="confirm_before_publish" ${s.confirm_before_publish ? "checked" : ""}> перед публикацией ждать моего нажатия</label>` : ""}
    </div>
    ${s.type === "plugin" ? "" : `<h3 style="margin-top:14px">Сценарии</h3>
    <div class="small muted" style="margin-bottom:6px">Общий сценарий работает для всех очередей. Если для очереди нужна другая категория на сайте — запишите для неё свой.</div>
    <table>${sc.map(([k, n]) => `<tr><td>${esc(scName(k))}</td><td class="small ${s.has_publish[k] ? "ok" : "warn"}">${n} шагов${s.has_publish[k] ? "" : " · нет «Опубликовать»"}</td>
      <td class="acts"><button data-sa="steps" data-line="${esc(k)}">Шаги</button>${s.type === "scenario" ? `<button data-sa="test" data-line="${esc(k)}">🧪 Тест</button>` : ""}
      <button data-sa="recline" data-line="${esc(k)}">● Перезаписать</button><button data-sa="delsc" data-line="${esc(k)}" class="danger">✕</button></td></tr>`).join("") || `<tr><td class="warn">Сценарий ещё не записан</td></tr>`}</table>
    <div class="row" style="margin-top:8px"><button data-sa="rec">● Записать новый сценарий…</button></div>`}
    <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="danger" data-sa="del">Удалить сайт</button></div></div>`;
}
function recordModal(s, pre){
  const opts = `<option value="default">общий — для всех очередей</option>` + boardQueues().map(q => `<option value="${q.id}" ${q.id === pre ? "selected" : ""}>только для «${esc(q.name)}»${s.scenarios[q.id] ? " (перезаписать)" : ""}</option>`).join("");
  const ov = modal(`<div class="mh"><h3>● Записать сценарий — ${esc(s.name)}</h3>${closeX}</div>
    <label class="field">Для какой очереди<select id="rcLine">${opts}</select></label>
    <ol class="steps small"><li>Откроется сайт с тёмной панелью Donini.</li><li>Выставляйте объявление как обычно: категория, галочки, город — кликами.</li>
      <li>Название / описание / цену / размер / код — кликните в поле сайта, потом на панели кнопку «Название» (и т.д.).</li><li>Фото — просто кнопка загрузки фото на сайте.</li>
      <li>Перед публикацией на панели «Следующий клик = Опубликовать», потом кнопка сайта — она запомнится, но не нажмётся. Затем «Готово».</li></ol>
    <div class="row"><button class="primary" id="rcGo">● Начать запись</button><button data-x>Отмена</button></div>`);
  $("#rcGo", ov).onclick = () => { ov.remove(); startRecord(s, $("#rcLine", ov).value); };
}
async function startRecord(s, line){
  if(s.type === "scenario") return act(() => post(`/api/site/${s.id}/record`, {line}), "Открываю сайт для записи (до минуты)…");
  if(!Q.ext_online) return toast("Расширение в браузере не отвечает — запись невозможна", true);
  const r = await ext({type: "record", site: s.id, line: line || "default"}, 30000);
  (!r || r.ok === false) ? toast((r && r.error) || "Не получилось начать запись", true) : toast("Запись началась в браузере — в конце нажмите «Готово» на тёмной панели");
}
async function stepsModal(siteId, line){
  const site = await api(`/api/site/${siteId}`);
  const steps = site.scenarios[line] || [];
  const ACT = {goto: "открыть", click: "клик", publish: "ОПУБЛИКОВАТЬ", fill: "вписать", select: "выбрать", selectText: "выбрать", pick: "выбрать в списке", choose: "выбрать", check: "галочка", upload: "фото", wait: "пауза"};
  const ov = modal("", "w2"), box = $(".modal", ov);
  const keep = () => $$("input[data-i]", box).forEach(i => steps[+i.dataset.i].value = i.value);
  const draw = () => { box.innerHTML = `<div class="mh"><h3>Шаги: ${esc(site.name)} — ${esc(scName(line))}</h3>${closeX}</div>
    <div class="small muted">Можно удалить лишний шаг или поменять текст. {title} — название, {body} — описание, {price} — цена, {size} — размер, {code} — код.</div>
    <table>${steps.map((s, i) => `<tr><td style="width:30px" class="muted">${i + 1}</td><td style="width:150px"><b class="${s.action === "publish" ? "ok" : ""}">${ACT[s.action] || s.action}</b></td>
      <td>${s.action === "fill" ? `<input data-i="${i}" value="${esc(s.value)}" style="width:100%">` : `${esc(s.label || s.url || s.value || "")}<div class="small muted"><code>${esc((s.selectors || [])[0] || "")}</code></div>`}</td>
      <td class="acts"><button class="danger" data-del="${i}">✕</button></td></tr>`).join("")}</table>
    <div class="row"><button class="primary" id="stSave">Сохранить</button><button data-x>Закрыть</button></div>`;
    $("#stSave", box).onclick = async () => { keep(); site.scenarios[line] = steps; if(await act(() => post(`/api/site/${siteId}`, {scenarios: site.scenarios}), "Шаги сохранены")){ ov.remove(); refresh(); } }; };
  box.addEventListener("click", e => { const d = e.target.closest("[data-del]"); if(!d) return; keep(); steps.splice(+d.dataset.del, 1); draw(); });
  draw();
}
function addSiteModal(){
  const ov = modal(`<div class="mh"><h3>＋ Новый сайт</h3>${closeX}</div>
    <div class="grid2"><label class="field">Название<input id="nsName" placeholder="Bazos.cz"></label><label class="field">Адрес сайта<input id="nsUrl" placeholder="https://www.bazos.cz/"></label>
    <label class="field">Язык текстов<select id="nsLang">${META.langs.map(l => `<option value="${l.code}">${l.code} — ${esc(l.name)}</option>`).join("")}</select></label>
    <label class="field">Как выставлять<select id="nsType"><option value="ext">в моём браузере — расширение (рекомендуется)</option><option value="scenario">браузер программы, в фоне</option></select></label></div>
    <div class="row"><button class="primary" id="nsGo">Добавить</button><button data-x>Отмена</button></div>`);
  $("#nsName", ov).focus();
  $("#nsGo", ov).onclick = async () => {
    const r = await act(() => post("/api/site_new", {name: $("#nsName", ov).value, start_url: $("#nsUrl", ov).value, lang: $("#nsLang", ov).value, type: $("#nsType", ov).value}));
    if(r){ ov.remove(); SITE_OPEN = r.id; await refresh(); drawSitesPage(); toast("Сайт добавлен. Дальше: «🔑 Войти» и «● Записать»"); }
  };
}

