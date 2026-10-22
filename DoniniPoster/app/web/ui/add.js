// «Добавить товары»: с компьютера (перетащить папки), из альбомов 微商相册 (WeChat), из каталога своего сайта.
let ADD_TAB = store("addTab") || "pc", SHOPS = [];
let CAT = {page: 1, items: [], cat: "", running: new Set(), refreshedAt: 0, busy: false};
const CAT_DONE = {}, CAT_FAIL = {};
PAGES.add = {
  show(){ drawAdd(); },
  refresh(){ if(ADD_TAB === "pc") drawPc(); },
  redraw(){ if(page === "add" && ADD_TAB === "pc") drawPc(); },
};
const lineSelOpts = (cur, auto) => (auto ? `<option value="__auto" ${cur === "__auto" ? "selected" : ""}>✨ Авто — по категории сайта</option>` : "") +
  boardQueues().map(l => `<option value="${esc(l.id)}" ${l.id === cur ? "selected" : ""}>${esc(l.name)}</option>`).join("");

function drawAdd(){
  $("#page-add").innerHTML = `<h1>Добавить товары</h1>
    <div class="subnav" id="addNav">
      <button data-at="pc">💻 С компьютера</button>
      <button data-at="wechat">🇨🇳 Из WeChat (微商相册)</button>
      <button data-at="site">🛍 Из каталога моего сайта</button>
    </div>
    <div id="addBody"></div>`;
  $$("#addNav [data-at]").forEach(b => b.onclick = () => { ADD_TAB = b.dataset.at; store("addTab", ADD_TAB); drawAdd(); });
  $$("#addNav [data-at]").forEach(b => b.classList.toggle("on", b.dataset.at === ADD_TAB));
  if(ADD_TAB === "pc") drawPc();
  if(ADD_TAB === "wechat") drawWechat();
  if(ADD_TAB === "site") drawCatalog();
}

// ---------- с компьютера ----------
function drawPc(){
  const body = $("#addBody"); if(!body || ADD_TAB !== "pc") return;
  const html = `<div class="card"><div class="small muted" style="margin-bottom:12px">Перетащите папки с фото на нужную очередь — или нажмите на неё и выберите папку.
      Можно много папок сразу или одну общую со всеми товарами. В названии папки можно указать размер (26x16), цену (699zl) и свой код (#83300).</div>
    <div class="grid3">${Q.queues.map(q => { const u = UP[q.id];
      return `<div class="drop" data-dl="${esc(q.id)}"><div style="font-size:22px">${q.id === "site" ? "🌐" : "📦"}</div><b>${esc(q.name)}</b><div class="small">в очереди: ${q.waiting}</div>
        ${u && u.total && u.done < u.total ? `<div class="pbar"><i style="width:${Math.round(u.done / u.total * 100)}%"></i></div><div class="small">загружаю ${u.done} из ${u.total}…</div>` : ""}
        ${u && u.msg ? `<div class="small ${u.err ? "err" : "ok"}">${esc(u.msg)}</div>` : ""}</div>`; }).join("")}</div></div>`;
  if(body.__h === html) return;
  body.innerHTML = html; body.__h = html;
  $$("[data-dl]", body).forEach(d => {
    d.onclick = () => pickFolder(d.dataset.dl);
    d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = async (e) => { e.preventDefault(); d.classList.remove("over"); uploadTo(d.dataset.dl, await collectDropped(e.dataTransfer)); };
  });
}

// ---------- WeChat ----------
async function drawWechat(){
  const body = $("#addBody"); body.__h = "";
  body.innerHTML = `<div class="card"><div class="row"><h3 style="margin:0;flex:1">Альбомы поставщиков</h3><button id="szOpen">🌐 Открыть 微商相册 в браузере</button></div>
    <div class="small muted" style="margin:6px 0 4px">Откройте в браузере альбом поставщика один раз — он появится здесь со списком разделов. Дальше: раздел и очередь → «⬇ Скачать».
      Альбом откроется в фоновом окне, фото скачаются в очередь, окно закроется само.</div><div id="szShops"><div class="muted small">Загружаю…</div></div></div>`;
  $("#szOpen").onclick = () => { if(!Q.ext_online) return toast("Расширение в браузере не отвечает", true); ext({type:"openTab", url: "https://www.szwego.com/"}); };
  try{ SHOPS = (await api("/api/szwego/shops")).shops; }catch(e){ SHOPS = []; }
  const box = $("#szShops");
  if(!SHOPS.length){ box.innerHTML = `<div class="empty">Пока нет альбомов. Нажмите «🌐 Открыть 微商相册 в браузере» и откройте альбом поставщика.</div>`; return; }
  box.innerHTML = SHOPS.map(sh => `<div class="shop" data-shop="${esc(sh.id)}">
      <div style="min-width:200px;flex:1"><b>${esc(sh.name)}</b> <button class="sm ghost" data-sh="rename" title="Переименовать">✏️</button><div class="small muted">разделов: ${sh.tags.length}</div></div>
      <select data-k="tag" style="max-width:240px"><option value="">весь альбом</option>${sh.tags.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (${t.count})</option>`).join("")}</select>
      <select data-k="line">${lineSelOpts(store("szLine_" + sh.id))}</select>
      <label class="check small"><input type="checkbox" data-k="new" checked> только новые</label>
      <button class="go" data-sh="go">⬇ Скачать в очередь</button><button data-sh="open">Открыть</button><button class="ghost danger" data-sh="del" title="Убрать из списка">✕</button></div>`).join("");
  box.onchange = e => { const row = e.target.closest("[data-shop]"); if(row && e.target.dataset.k === "line") store("szLine_" + row.dataset.shop, e.target.value); };
  box.onclick = async e => {
    const b = e.target.closest("[data-sh]"); if(!b) return;
    const row = b.closest("[data-shop]"), sh = SHOPS.find(x => x.id === row.dataset.shop);
    if(b.dataset.sh === "open"){ if(!Q.ext_online) return toast("Расширение в браузере не отвечает", true); ext({type:"openTab", url: sh.url}); return; }
    if(b.dataset.sh === "rename"){ const n = await ask("Название альбома", "Название", sh.name); if(n){ await act(() => post("/api/szwego/shop/rename", {id: sh.id, name: n})); drawWechat(); } return; }
    if(b.dataset.sh === "del"){ if(confirm("Убрать альбом из списка? Откроете его в браузере — появится снова.")){ await act(() => post("/api/szwego/shop/rename", {id: sh.id, delete: true})); drawWechat(); } return; }
    if(b.dataset.sh === "go"){
      if(!Q.ext_online) return toast("Расширение в браузере не отвечает — WeChat скачивается через браузер, где вы вошли в аккаунт", true);
      const tag = $('[data-k="tag"]', row);
      const msg = {type: "szwegoAll", url: sh.url, tag: tag.value, tagName: tag.selectedOptions[0].textContent.replace(/\s*\(\d+\)$/, ""),
        line: $('[data-k="line"]', row).value, only_new: $('[data-k="new"]', row).checked};
      b.disabled = true; b.textContent = "Скачиваю… (ход — в журнале)";
      const r = await ext(msg, 3600000);
      b.disabled = false; b.textContent = "⬇ Скачать в очередь";
      if(r && r.ok) toast(`Готово: «${r.tagName}» — в очередь ${r.done}, уже были ${r.skipped}, без размера ${r.noSize}${r.errors ? `, ошибок ${r.errors}` : ""}`);
      else toast("Не получилось: " + ((r && r.error) || "расширение не ответило"), true);
      refresh();
    }
  };
}

// ---------- каталог своего сайта ----------
async function fetchT(url, ms = 30000){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try{ return await (await fetch(url, {signal: ctl.signal})).json(); } finally { clearTimeout(t); }
}
function drawCatalog(){
  const body = $("#addBody"); body.__h = "";
  body.innerHTML = `<div class="card">
    <div class="row" style="margin-bottom:10px"><h3 style="margin:0;flex:1">Товары с doninisklep.com → в очередь для досок</h3><span id="pullInfo" class="small muted"></span></div>
    <div class="row">
      <label class="field" style="min-width:260px">Категория<select id="catCats"><option value="">загружаю категории…</option></select></label>
      <label class="field">Бренд<select id="catBrand"><option value="">все бренды</option></select></label>
      <label class="field" style="flex:1;min-width:180px">Поиск<input id="catSearch" placeholder="название, модель, артикул…"></label>
      <label class="field">Кладу в очередь<select id="pullLine">${lineSelOpts(store("pullLine") || "__auto", true)}</select></label>
      <label class="check small" style="align-self:flex-end;margin-bottom:8px"><input type="checkbox" id="catHide" ${store("catHide") === "1" ? "checked" : ""}> скрыть уже в очереди</label>
    </div>
    <div class="row" style="margin:10px 0">
      <span class="small muted" style="flex:1">Нажмите на товар — он скачается в очередь (можно подряд).</span>
      <button id="catReload" title="Подтянуть новые товары с сайта">⟳ Обновить с сайта</button>
      <button id="catAll">⬇ Все на странице</button>
      <button class="go" id="catAllF">⬇ Скачать все по фильтру</button>
      <button class="danger hidden" id="pullStop">■ Стоп</button>
    </div>
    <div id="catProg" class="banner info hidden" style="margin-bottom:10px"><div class="t"><b id="catProgT"></b><div class="pbar"><i id="catProgBar" style="width:0%"></i></div></div></div>
    <div id="catGrid" class="catgrid"></div>
    <div class="row" style="justify-content:center;margin-top:12px"><button id="catMore" class="hidden">Показать ещё</button></div></div>`;
  $("#pullLine").onchange = e => store("pullLine", e.target.value);
  $("#catHide").onchange = e => { store("catHide", e.target.checked ? "1" : ""); catRender(); };
  $("#catBrand").onchange = () => { store("catBrand", $("#catBrand").value); catLoad(true); };
  let t = null; $("#catSearch").oninput = () => { clearTimeout(t); t = setTimeout(() => catLoad(true), 500); };
  $("#catCats").onchange = e => { CAT.cat = e.target.value; store("catCat", CAT.cat); catLoad(true); };
  $("#catReload").onclick = () => catRefresh(true);
  $("#catMore").onclick = () => { CAT.page++; catLoad(false); };
  $("#catAll").onclick = () => { const ids = CAT.items.filter(p => !p.in_queue).map(p => p.id); if(!ids.length) return toast("Все товары на странице уже в очереди");
    if(confirm(`Скачать в очередь ${ids.length} товаров?`)) catPull(ids); };
  $("#catAllF").onclick = catAllFiltered;
  $("#pullStop").onclick = async () => { await post("/api/woo/pull/stop"); pullStatus(); };
  $("#catGrid").onclick = e => { const tl = e.target.closest(".ptile"); if(!tl) return; const p = CAT.items.find(x => String(x.id) === tl.dataset.pid); if(!p) return;
    if(p.in_queue && !confirm("Этот товар уже лежит в очереди. Скачать ещё раз (будет вторая копия)?")) return; catPull([p.id]); };
  catRefresh(false); pullStatus();
}
setInterval(() => { if(page === "add" && ADD_TAB === "site" && CAT.page === 1 && $("#catSearch") && !$("#catSearch").value && Date.now() - CAT.refreshedAt > 110000) catRefresh(false); }, 20000);
async function catRefresh(manual){
  if(CAT.busy || (CAT.running.size && !manual)) return;
  CAT.busy = true; CAT.refreshedAt = Date.now();
  const btn = $("#catReload"); if(btn) btn.disabled = true;
  try{
    let err = "";
    try{ const r = await fetchT("/api/woo/lists?fresh=1");
      if(!r.categories) err = r.detail || "сайт не ответил";
      else { const cats = r.categories.filter(c => c.count > 0).sort((a, b) => b.count - a.count);
        let sc = store("catCat") || ""; if(sc && !cats.some(c => String(c.id) === sc)) sc = ""; CAT.cat = sc;
        $("#catCats").innerHTML = `<option value="">все категории</option>` + cats.map(c => `<option value="${c.id}" ${String(c.id) === sc ? "selected" : ""}>${esc(c.name)} · ${c.count}</option>`).join(""); }
    }catch(e){ err = e.name === "AbortError" ? "сайт doninisklep.com долго не отвечает" : String(e.message || e); }
    if(err && $("#catCats").options.length < 2){ $("#catCats").innerHTML = `<option value="">категории не загрузились</option>`; toast("Категории не загрузились: " + err, true); }
    try{ const b = await fetchT("/api/woo/brands?fresh=1"); if(b.brands){ $("#catBrand").innerHTML = `<option value="">все бренды</option>` + b.brands.filter(x => x.count).map(x => `<option value="${x.id}">${esc(x.name)} (${x.count})</option>`).join("");
      const sb = store("catBrand") || ""; if([...$("#catBrand").options].some(o => o.value === sb)) $("#catBrand").value = sb; } }catch(e){}
    await catLoad(true);
    if(manual) toast("✓ Каталог обновлён с сайта");
  } finally { CAT.busy = false; if(btn) btn.disabled = false; }
}
function catQuery(pg){ return new URLSearchParams({category: CAT.cat, brand: $("#catBrand").value, search: $("#catSearch").value.trim(), page: pg ?? CAT.page}); }
function catFilterName(){
  const cat = CAT.cat ? ($("#catCats").selectedOptions[0] || {textContent: ""}).textContent.replace(/\s*·.*$/, "") : "";
  const br = $("#catBrand").value ? $("#catBrand").selectedOptions[0].textContent.replace(/\s*\(\d+\)$/, "") : "";
  const q = $("#catSearch").value.trim();
  return [br, cat, q && `«${q}»`].filter(Boolean).join(" · ") || "весь каталог";
}
async function catLoad(reset){
  if(!$("#catGrid")) return;
  $("#catAllF").textContent = `⬇ Скачать все: ${catFilterName()}`;
  if(reset){ CAT.page = 1; CAT.items = []; $("#catGrid").innerHTML = `<div class="empty">Загружаю товары с сайта…</div>`; }
  $("#catMore").classList.add("hidden");
  let r = null, er = "";
  try{ r = await fetchT("/api/woo/catalog?" + catQuery(), 45000); }catch(e){ er = e.name === "AbortError" ? "Сайт doninisklep.com долго не отвечает." : "Программа не ответила."; }
  if(!r || !r.products){ $("#catGrid").innerHTML = `<div class="empty">${esc(er || (r && r.detail) || "Сайт не подключён — очередь «Мой сайт» → «⚙️ Настройки очереди».")}<br><button class="sm" style="margin-top:8px" onclick="catRefresh(true)">⟳ Ещё раз</button></div>`; return; }
  CAT.items = CAT.items.concat(r.products);
  $("#catMore").classList.toggle("hidden", !r.more);
  catRender();
}
function catRender(){
  const g = $("#catGrid"); if(!g) return;
  const hide = $("#catHide").checked, list = CAT.items.filter(p => !(hide && p.in_queue));
  g.innerHTML = list.length ? list.map(p => `<div class="ptile${p.in_queue ? " done" : ""}" data-pid="${p.id}" title="${esc(p.name)}">
      ${CAT_DONE[p.id] || p.in_queue ? `<span class="bdg">✓ в очереди</span>` : ""}<img loading="lazy" src="${esc(p.img)}" alt="">
      ${CAT.running.has(p.id) ? `<div class="ovl"><div class="spin"></div>Скачиваю…</div>` :
        CAT_DONE[p.id] && Date.now() - CAT_DONE[p.id].t < 4000 ? `<div class="ovl ok">✓ Добавлено<br>в «${esc(CAT_DONE[p.id].line)}»</div>` :
        CAT_FAIL[p.id] ? `<div class="ovl er">⚠️ Не скачалось<br>нажмите ещё раз</div>` : ""}
      <div class="pi"><b>${esc(p.brand || "")}</b> ${esc(p.size || "")}<br><span class="muted">${p.price ? esc(p.price) + " zł · " : ""}${p.photos} фото${p.sku ? " · " + esc(p.sku) : ""}</span></div></div>`).join("")
    : `<div class="empty">${$("#catBrand").value || $("#catSearch").value.trim() || hide ? `Ничего не найдено с этими фильтрами (${esc(catFilterName())}). <button class="sm" id="catReset">✕ Сбросить фильтры</button>` : "В этой категории товаров нет"}</div>`;
  const rs = $("#catReset"); if(rs) rs.onclick = () => { $("#catBrand").value = ""; $("#catSearch").value = ""; $("#catHide").checked = false; store("catHide", ""); catLoad(true); };
}
async function catPull(ids){
  ids = ids.filter(id => !CAT.running.has(id)); if(!ids.length) return;
  ids.forEach(id => { CAT.running.add(id); delete CAT_FAIL[id]; }); catRender();
  toast(ids.length > 1 ? `⬇ Скачиваю ${ids.length} товаров…` : "⬇ Скачиваю в очередь…");
  const r = await act(() => post("/api/woo/pull_ids", {ids, line: $("#pullLine").value}));
  if(!r || r.ok === false){ if(r) toast(r.error, true); ids.forEach(id => CAT.running.delete(id)); catRender(); return; }
  setTimeout(pullStatus, 800);
}
async function catAllFiltered(){
  const b = $("#catAllF"); b.disabled = true; const old = b.textContent; b.textContent = "Считаю товары…";
  let r; try{ r = await api("/api/woo/catalog_ids?" + catQuery()); }catch(e){ toast(e.message, true); return; } finally { b.disabled = false; b.textContent = old; }
  const name = catFilterName();
  if(!r.total) return toast(`${name}: товаров с фото нет`);
  if(!r.new.length){ if(confirm(`${name}: все ${r.total} товаров уже в очереди.\n\nСкачать ещё раз (будут вторые копии)?`)) catPull(r.ids); return; }
  const skip = r.total - r.new.length;
  if(confirm(`${name}: ${r.total} товаров на сайте${skip ? `, ${skip} уже в очереди — пропущу` : ""}.\n\nСкачать в очередь ${r.new.length} товаров?`)) catPull(r.new);
}
async function pullStatus(){
  let st; try{ st = await (await fetch("/api/woo/pull/status")).json(); }catch(e){ return; }
  if(!$("#catGrid")) return;
  $("#pullStop").classList.toggle("hidden", !st.running);
  $("#pullInfo").textContent = st.running ? `скачиваю ${st.done} из ${st.total}${st.errors ? `, ошибок ${st.errors}` : ""}…` : (st.msg || "");
  let changed = false;
  for(const [id, line] of Object.entries(st.done_ids || {})){ const k = Number(id);
    if(CAT.running.has(k)){ CAT.running.delete(k); CAT_DONE[k] = {line, t: Date.now()}; changed = true; const it = CAT.items.find(x => x.id === k); if(it) it.in_queue = true; } }
  for(const id of st.failed_ids || []){ const k = Number(id); if(CAT.running.has(k)){ CAT.running.delete(k); CAT_FAIL[k] = 1; changed = true; toast("⚠️ Товар не скачался — сайт не ответил. Нажмите ещё раз.", true); } }
  const pr = $("#catProg");
  if(st.running || CAT.running.size){ pr.classList.remove("hidden"); $("#catProgT").textContent = `⬇ Скачиваю в очередь: ${st.done} из ${st.total}${st.errors ? ` · ошибок ${st.errors}` : ""}`;
    $("#catProgBar").style.width = (st.total ? Math.round(st.done / st.total * 100) : 5) + "%"; }
  else if(Object.keys(st.done_ids || {}).length){ pr.classList.remove("hidden");
    $("#catProgT").textContent = `✓ Готово: добавлено ${Object.keys(st.done_ids).length} в «${[...new Set(Object.values(st.done_ids))].join("», «")}»${st.errors ? ` · не скачалось ${st.errors}` : ""}`; $("#catProgBar").style.width = "100%"; }
  if(changed){ catRender(); setTimeout(catRender, 4200); refresh(); }
  if(!st.running && CAT.running.size){ CAT.running.clear(); catRender(); }
  if((st.running || CAT.running.size) && page === "add") setTimeout(pullStatus, 1000);
}
