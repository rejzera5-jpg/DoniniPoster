// «Сводка» — всё главное на одном экране: очереди с кнопками, что сегодня выставлено, что требует внимания.
// «Instagram» — заготовка раздела на будущее.
PAGES.home = { show(){ drawHome(); }, refresh(){ drawHome(true); } };
PAGES.insta = { show(){ drawInsta(); } };
let HOME_LOG = [];
async function homeLog(){ try{ HOME_LOG = (await api("/api/logs?n=60")).logs.slice(-12).reverse(); }catch(e){} }
setInterval(() => { if(page === "home") homeLog(); }, 5000);

function homeIssues(){
  const out = [];
  if(!Q.ext_online) out.push({cls: "err", t: "Расширение в браузере не отвечает — доски не выставляются.", btn: `<button class="sm" data-act="brRestart">🔄 Перезапустить браузер</button>`});
  for(const q of boardQueues()){
    if(q.waiting && !q.sites.length) out.push({cls: "warn", t: `У очереди «${esc(q.name)}» ждут ${q.waiting} товаров, но не выбраны сайты.`, btn: `<button class="sm" data-hq="${q.id}" data-set="1">Выбрать сайты</button>`});
    const miss = q.sites.map(siteById).filter(s => s && s.type !== "plugin" && !s.scenarios[q.id] && !s.scenarios.default);
    if(miss.length) out.push({cls: "warn", t: `«${esc(q.name)}»: нет записи для ${miss.map(s => esc(s.name)).join(", ")} — туда товары не пойдут.`, btn: `<button class="sm" data-page2="sites">Записать</button>`});
    const off = q.sites.map(siteById).filter(s => s && !s.enabled);
    if(q.waiting && off.length) out.push({cls: "info", t: `«${esc(q.name)}»: сайт ${off.map(s => esc(s.name)).join(", ")} выключен.`, btn: `<button class="sm" data-page2="sites">Сайты</button>`});
    if(q.errors) out.push({cls: "err", t: `«${esc(q.name)}»: ${q.errors} товаров с ошибкой.`, btn: `<button class="sm" data-hq="${q.id}" data-tab2="err">Посмотреть</button>`});
  }
  if(!Q.telegram_ok) out.push({cls: "info", t: "Telegram не подключён — уведомления об ошибках и капчах не приходят.", btn: `<button class="sm" data-page2="settings" data-setp="tg">Подключить</button>`});
  return out;
}
function qCard(q){
  const d = q.run === "run" ? (q.working || q.id === "site" ? "run" : "wait") : q.run === "pause" ? "pause" : "";
  return `<div class="qcard ${q.run === "run" ? "run" : q.run === "pause" ? "pause" : ""}" data-hq="${q.id}">
    <div class="row"><i class="dot ${d}"></i><b style="flex:1">${esc(q.name)}</b><span class="pill ${q.run === "run" ? "run" : q.run === "pause" ? "pause" : ""}">${STATE[q.run]}</span></div>
    <div class="nums"><span><b>${q.waiting}</b>ждут</span><span><b>${q.done_today}</b>сегодня</span><span><b class="${q.errors ? "err" : ""}">${q.errors}</b>ошибки</span></div>
    <div class="small muted" style="min-height:16px">${q.sites.length ? esc(q.sites.map(siteName).join(", ")) : "сайты не выбраны"}</div>
    <div class="mini"><button class="go" data-hr="run" title="Старт">▶</button><button data-hr="pause" title="Пауза">⏸</button><button class="danger" data-hr="stop" title="Стоп">■</button></div></div>`;
}
function drawHome(soft){
  const box = $("#page-home"); if(!box || page !== "home") return;
  if(soft && (editing(box) || document.querySelector(".ov"))) return;
  const all = Q.queues, main = all.filter(q => q.group === "main"), more = all.filter(q => q.group !== "main");
  const today = all.reduce((a, q) => a + q.done_today, 0), wait = all.reduce((a, q) => a + q.waiting, 0), errs = all.reduce((a, q) => a + q.errors, 0);
  const running = all.filter(q => q.run === "run");
  const issues = homeIssues();
  const sitesToday = Q.sites.filter(s => s.enabled || s.today);
  const html = `<div class="row"><h1>Сводка</h1><span class="spacer"></span>
      <span class="muted small">${running.length ? "Работают: " + running.map(q => esc(q.name)).join(", ") : "Сейчас ничего не выставляется"}</span></div>
    <div class="tiles">
      <div class="tile"><b>${today}</b><span>опубликовано сегодня</span></div>
      <div class="tile"><b>${wait}</b><span>ждут выставления</span></div>
      <div class="tile"><b class="${errs ? "err" : ""}">${errs}</b><span>с ошибкой</span></div>
      <div class="tile"><b>${running.length}</b><span>очередей работает</span></div>
    </div>
    ${issues.length ? `<div class="card"><h3>Требует внимания</h3>${issues.map(i => `<div class="banner ${i.cls}" style="margin-top:8px"><div class="t">${i.t}</div>${i.btn}</div>`).join("")}</div>`
      : `<div class="banner ok"><div class="t">✓ Всё в порядке: расширение на связи, у всех очередей есть сайты и записи.</div></div>`}
    <div class="qcards">${main.map(qCard).join("")}</div>
    ${more.length ? `<details class="card"${more.some(q => q.run !== "stop" || q.waiting) ? " open" : ""}><summary style="cursor:pointer"><b>Ещё очереди (${more.length})</b></summary><div class="qcards" style="margin-top:12px">${more.map(qCard).join("")}</div></details>` : ""}
    <div class="grid2">
      <div class="card"><h3>Сайты сегодня</h3><div>${sitesToday.map(s => `<span class="chip ${s.today ? "done" : ""}" title="${esc(s.enabled ? "включён" : "выключен")}">${esc(s.name)}: ${s.today}</span>`).join("") || `<span class="muted small">нет включённых сайтов</span>`}</div></div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0;flex:1">Последние события</h3><button class="sm" data-page2="log">Журнал →</button></div>
        <div class="loglist" style="max-height:260px">${HOME_LOG.map(l => `<div class="${logCls(l)}">${esc(l)}</div>`).join("") || `<span class="muted">пока пусто</span>`}</div></div>
    </div>`;
  if(box.__h === html) return;
  box.innerHTML = html; box.__h = html;
  box.onclick = async e => {
    const r = e.target.closest("[data-hr]");
    if(r){ e.stopPropagation(); return runQueue(r.dataset.hr, r.closest("[data-hq]").dataset.hq); }
    const p = e.target.closest("[data-page2]"); if(p){ if(p.dataset.setp) store("setp", p.dataset.setp), SET_TAB = p.dataset.setp; return go(p.dataset.page2); }
    const q = e.target.closest("[data-hq]");
    if(q){ go("q:" + q.dataset.hq); if(q.dataset.tab2) setTab(q.dataset.tab2); if(q.dataset.set){ setOpen = true; drawSet(); } }
  };
}
homeLog().then(() => { if(page === "home"){ $("#page-home").__h = ""; drawHome(); } });

function drawInsta(){
  $("#page-insta").innerHTML = `<div class="row"><h1>📸 Instagram</h1><span class="pill info">скоро</span></div>
    <div class="card"><h3>Что здесь будет</h3>
      <div class="muted">Раздел для Instagram: товары из этих же очередей → посты и сторис по расписанию. Те же кнопки Старт / Пауза / Стоп и уведомления в Telegram.</div>
      <ul class="soon">
        <li>посты из выбранной очереди: фото товара + текст + хэштеги (текст — из шаблонов Donini);</li>
        <li>сколько постов в день и в какие часы;</li>
        <li>ежедневная сторис;</li>
        <li>видно, что опубликовано, а что ждёт; ошибки — красным, как в очередях;</li>
        <li>уведомления в Telegram, как для досок.</li>
      </ul></div>
    <div class="grid2">
      <div class="card"><h3>Аккаунт</h3><div class="muted small">Подключение аккаунта Instagram появится здесь.</div>
        <div class="row" style="margin-top:10px"><button disabled>Подключить аккаунт</button></div></div>
      <div class="card"><h3>Расписание</h3><div class="muted small">Очередь, постов в день, часы публикации.</div>
        <div class="grid2" style="margin-top:10px"><label class="field">Очередь<select disabled>${boardQueues().map(q => `<option>${esc(q.name)}</option>`).join("")}</select></label>
          <label class="field">Постов в день<input disabled value="5"></label></div></div>
    </div>
    <div class="small muted">Чтобы начать делать этот раздел, напишите: какой аккаунт, какие товары и в какое время публиковать.</div>`;
}
