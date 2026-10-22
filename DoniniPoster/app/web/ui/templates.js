// «Шаблоны Donini»: Donini Manager — тексты объявлений для всех стран.
// ---------- шаблоны Donini Manager ----------
let MGR_TPL = null;
PAGES.tpl = { show(){ drawTpl(); }, refresh(){} };
function drawTpl(){
  const used = (id) => Q.queues.filter(l => l.template === id).map(l => l.name);
  const types = META.types.slice().sort((a, b) => used(b.id).length - used(a.id).length);
  let cur = MGR_TPL || store("plt_productType") || (types[0] || {}).id;
  if(!types.some(t => t.id === cur)) cur = (types[0] || {}).id;
  store("plt_productType", cur); MGR_TPL = null;
  $("#page-tpl").innerHTML = `<h1>Шаблоны Donini</h1><div class="row" style="margin-bottom:10px"><label class="field" style="min-width:320px">Шаблон
      <select id="mgrSel">${types.map(t => `<option value="${esc(t.id)}" ${t.id === cur ? "selected" : ""}>${esc(t.label)}${used(t.id).length ? " — " + esc(used(t.id).join(", ")) : ""}</option>`).join("")}</select></label>
    <div class="small muted" style="flex:1;min-width:260px">Правки сразу сохраняются и применяются ко всем товарам с этим шаблоном (кроме товаров со своим текстом ✏️).</div>
    <button id="tplImp">⤵ Импорт кода шаблонов</button></div>
    <iframe class="mgr" id="mgrFrame" src="/manager"></iframe>`;
  $("#mgrSel").onchange = e => { store("plt_productType", e.target.value); $("#mgrFrame").contentWindow.location.reload(); };
  $("#tplImp").onclick = () => {
    const ov = modal(`<div class="mh"><h3>Импорт шаблонов из Donini Manager</h3>${closeX}</div>
      <div class="small muted">В Donini нажмите «Скопировать мои шаблоны текста» и вставьте код сюда. В тексте можно писать <b>{size}</b>.</div>
      <textarea id="tplCode" rows="4" placeholder="PLT-ШАБЛОНЫ-1:..."></textarea><div class="row"><button class="primary" id="tplGo">Импортировать</button><button data-x>Отмена</button></div>`);
    $("#tplGo", ov).onclick = async () => { const r = await act(() => post("/api/templates/import", {code: $("#tplCode", ov).value})); if(r){ META = await api("/api/meta"); ov.remove(); toast(`Импортировано шаблонов: ${r.count}`); drawTpl(); } };
  };
}

