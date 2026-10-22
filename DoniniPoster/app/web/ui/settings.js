// Настройки: сайты и сценарии, публикация, Telegram, шаблоны Donini, коды и цены, бренд по фото, программа, инструкция.
let SET_TAB = store("setp") || "pub";
PAGES.settings = { show(){ drawSettings(); }, refresh(){} };
const SECTIONS = [["pub", "⏱ Публикация"], ["tg", "📨 Telegram"], ["codes", "🔢 Коды, цены, фото"],
  ["ai", "🤖 Бренд по фото"], ["app", "💻 Программа и перенос"], ["help", "📘 Инструкция"]];
function showSet(k){ if(!SECTIONS.some(x => x[0] === k)) k = "pub"; SET_TAB = k; store("setp", k); if(page === "settings") drawSettings(); }
function drawSettings(){
  $("#page-settings").innerHTML = `<h1>Настройки</h1><div class="subnav" id="setNav">${SECTIONS.map(([k, t]) => `<button data-set="${k}" class="${k === SET_TAB ? "on" : ""}">${t}</button>`).join("")}</div><div id="setBody"></div>`;
  $$("#setNav [data-set]").forEach(b => b.onclick = () => showSet(b.dataset.set));
  if(!SECTIONS.some(x => x[0] === SET_TAB)) SET_TAB = "pub";
  ({pub: drawPub, tg: drawTg, codes: drawCodes, ai: drawAi, app: drawApp, help: drawHelp}[SET_TAB])();
}
// ---------- публикация ----------
async function drawPub(){
  const body = $("#setBody");
  body.innerHTML = `<div class="card muted">Спрашиваю у расширения…</div>`;
  const [p, cfg] = await Promise.all([ext({type: "pubGet"}), api("/api/config").catch(() => ({}))]);
  if(SET_TAB !== "pub" || page !== "settings") return;  // пока ждали ответа, открыли другой раздел
  const wh = cfg.work_hours || [0, 24];
  body.innerHTML = `<div class="grid2">
    <div class="card"><h3>Доски объявлений</h3>${!p ? `<div class="banner warn"><div class="t">Эти настройки хранятся в расширении, а оно сейчас не отвечает. Когда «● Расширение на связи», откройте эту страницу снова.</div></div>` : `
      <div class="field">Кто нажимает «Опубликовать»</div>
      <div class="seg" id="pMode"><button data-v="auto" class="${p.mode === "auto" ? "on" : ""}">🤖 программа сама</button><button data-v="manual" class="${p.mode !== "auto" ? "on" : ""}">🙋 я проверяю и нажимаю</button></div>
      <div class="grid2" style="margin-top:12px"><label class="field">Пауза между товарами, минут<input id="pInt" type="number" min="0" step="0.5" value="${esc((p.interval || 0) / 60)}"></label>
        <label class="field">Случайный разброс паузы, ±%<input id="pJit" type="number" min="0" max="90" step="5" value="${esc(p.jitter ?? 20)}"></label>
        <label class="field">Пауза в пачке на один сайт, сек<input id="pBatch" type="number" min="0" value="${esc(p.batchPause ?? 15)}"></label></div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="pAlways" ${p.always ? "checked" : ""}> паузу делать и когда «Опубликовать» нажимаю я</label>
      <label class="check" style="margin-top:6px"><input type="checkbox" id="pBg" ${p.background !== false ? "checked" : ""}> работать в фоне — окно выставления позади, меня на вкладки не переключать</label>
      <div class="small muted" style="margin:10px 0">Например 1.5 мин ±20% — каждый раз от 1:12 до 1:48: сайты видят обычного продавца, а не робота. Пауза считается после того, как товар выставлен на всех его сайтах.</div>
      <button class="primary" id="pSave">Сохранить</button>`}</div>
    <div class="card"><h3>Мой сайт и фоновые сайты</h3>
      <div class="small muted">Пауза между товарами для doninisklep.com — в очереди «Мой сайт» → «⚙️ Настройки очереди».</div>
      <div class="field" style="margin-top:12px">Рабочие часы для сайтов «браузер программы, в фоне»</div>
      <div class="row"><label class="field">с, час<input id="wh1" type="number" min="0" max="23" value="${esc(wh[0])}" style="width:90px"></label><label class="field">до, час<input id="wh2" type="number" min="1" max="24" value="${esc(wh[1])}" style="width:90px"></label>
        <button id="whSave" style="align-self:flex-end">Сохранить</button></div>
      <div class="small muted" style="margin-top:6px">На доски через расширение и на мой сайт рабочие часы не действуют — там работают кнопки Старт / Пауза / Стоп.</div></div></div>`;
  if(p){
    let mode = p.mode;
    $$("#pMode button").forEach(b => b.onclick = () => { mode = b.dataset.v; $$("#pMode button").forEach(x => x.classList.toggle("on", x === b)); });
    $("#pSave").onclick = async () => {
      const r = await ext({type: "pubSet", mode, interval: Math.max(0, Math.round((Number(String($("#pInt").value).replace(",", ".")) || 0) * 60)),
        jitter: Math.max(0, Math.min(90, Number($("#pJit").value) || 0)), batchPause: Math.max(0, Number($("#pBatch").value) || 0),
        always: $("#pAlways").checked, background: $("#pBg").checked});
      r ? toast("Сохранено") : toast("Расширение не ответило", true);
    };
  }
  $("#whSave").onclick = () => act(() => post("/api/config", {work_hours: [Number($("#wh1").value) || 0, Number($("#wh2").value) || 24]}), "Сохранено");
}

// ---------- Telegram ----------
async function drawTg(){
  const cfg = await api("/api/config").catch(() => ({})), tg = cfg.telegram || {};
  if(SET_TAB !== "tg" || page !== "settings") return;
  $("#setBody").innerHTML = `<div class="card" style="max-width:760px"><h3>Уведомления в Telegram</h3>
    <ol class="steps small"><li>В Telegram найдите <b>@BotFather</b>, отправьте <code>/newbot</code>, придумайте имя — он пришлёт токен.</li>
      <li>Вставьте токен ниже, откройте своего нового бота и нажмите «Start».</li><li>Нажмите «Найти chat id» — всё сохранится само.</li></ol>
    <div class="grid2" style="margin-top:10px"><label class="field">Токен бота<input id="tgTok" value="${esc(tg.token || "")}" placeholder="123456:ABC…"></label>
      <label class="field">Chat id<input id="tgChat" value="${esc(tg.chat_id || "")}"></label></div>
    <div class="row" style="margin-top:12px"><button id="tgFind">🔎 Найти chat id</button><button id="tgTest">📨 Отправить проверку</button><button class="primary" id="tgSave">Сохранить</button>
      <span class="small ${Q.telegram_ok ? "ok" : "muted"}">${Q.telegram_ok ? "● подключено" : "не подключено"}</span></div>
    <div class="small muted" style="margin-top:12px">Приходит: запуск программы и продолжение работы после перезагрузки, ошибки и капчи, итоги по товарам, отчёты.</div></div>`;
  $("#tgFind").onclick = async () => { const r = await act(() => post("/api/telegram/find", {token: $("#tgTok").value.trim()})); if(r){ $("#tgChat").value = r.chat_id; toast("Chat id найден и сохранён"); refresh(); } };
  $("#tgTest").onclick = () => act(() => post("/api/telegram/test", {token: $("#tgTok").value.trim(), chat_id: $("#tgChat").value.trim()}), "Отправлено — проверьте Telegram");
  $("#tgSave").onclick = async () => { if(await act(() => post("/api/config", {telegram: {token: $("#tgTok").value.trim(), chat_id: $("#tgChat").value.trim()}}), "Сохранено")) refresh(); };
}

// ---------- коды, цены, фото ----------
async function drawCodes(){
  const c = await api("/api/config");
  if(SET_TAB !== "codes" || page !== "settings") return;
  $("#setBody").innerHTML = `<div class="grid2">
    <div class="card"><h3>Коды товаров</h3>
      <label class="field">Последний использованный код (следующий будет +1)<input id="sCounter" type="number" value="${esc(c.code_counter)}"></label>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="sShared" ${c.shared_counter ? "checked" : ""}> один общий счётчик кодов для всех очередей</label>
      <div class="small muted" style="margin-top:8px">Товары, скачанные с моего сайта, сохраняют свой артикул с сайта.</div></div>
    <div class="card"><h3>Курсы валют (за 1 zł)</h3>
      <div class="grid2">${["EUR", "HUF", "RON", "CZK"].map(k => `<label class="field">${k}<input id="r_${k}" value="${esc(c.rates[k])}"></label>`).join("")}</div>
      <div class="small muted" style="margin-top:8px">Цены округляются вверх: …9, CZK …90, HUF …990.</div></div>
    <div class="card"><h3>Фото</h3>
      <label class="field">Плохие фото (битые, недокачанные, замыленные, повторы)<select id="sQc">
        <option value="normal" ${(c.photo_qc || "normal") === "normal" ? "selected" : ""}>убирать</option><option value="soft" ${c.photo_qc === "soft" ? "selected" : ""}>убирать только явно плохие</option>
        <option value="strict" ${c.photo_qc === "strict" ? "selected" : ""}>убирать строже</option><option value="off" ${c.photo_qc === "off" ? "selected" : ""}>не проверять</option></select></label>
      <label class="field" style="margin-top:10px">Максимальный размер фото, px<input id="sPx" type="number" value="${esc(c.photo_max_side)}"></label>
      <label class="field" style="margin-top:10px">Удалять фото выставленных через, дней (0 — не удалять)<input id="sDel" type="number" value="${esc(c.delete_done_after_days)}"></label></div>
    <div class="card"><h3>Папки</h3>
      <label class="field">Папка очередей<input id="sQueue" value="${esc(c.queue_root)}"></label>
      <label class="field" style="margin-top:10px">Папка «Выставлено»<input id="sDone" value="${esc(c.done_root)}"></label>
      <div class="row" style="margin-top:10px"><button id="sOpenQ">📂 Открыть папку очередей</button></div></div>
  </div><div class="row" style="margin-top:14px"><button class="primary" id="sSave">Сохранить</button></div>`;
  $("#sOpenQ").onclick = () => post("/api/open_folder", {});
  $("#sSave").onclick = async () => {
    const num = (id) => Number(String($(id).value).replace(",", "."));
    if(await act(() => post("/api/config", {code_counter: num("#sCounter"), code_counter_was: c.code_counter, shared_counter: $("#sShared").checked,
      rates: {EUR: num("#r_EUR"), HUF: num("#r_HUF"), RON: num("#r_RON"), CZK: num("#r_CZK")}, photo_qc: $("#sQc").value, photo_max_side: num("#sPx"),
      delete_done_after_days: num("#sDel"), queue_root: $("#sQueue").value.trim(), done_root: $("#sDone").value.trim()}), "Сохранено")) refresh();
  };
}

// ---------- бренд по фото (ИИ) ----------
async function drawAi(){
  const c = await api("/api/config");
  if(SET_TAB !== "ai" || page !== "settings") return;
  $("#setBody").innerHTML = `<div class="card" style="max-width:760px"><h3>🤖 Бренд по фото</h3>
    <div class="small muted">Если поставщик не написал бренд, ИИ (Claude) смотрит на фото и ставит бренд сам — при скачивании из WeChat и кнопкой «🤖 Бренд по фото» у выбранных товаров.
      Нужен свой ключ Claude API: console.anthropic.com → API Keys (там же пополнить счёт; одно фото стоит доли цента).</div>
    <label class="field" style="margin-top:12px">Ключ Claude API<input id="aiKey" type="password" autocomplete="off" placeholder="${c.ai_key_set ? "ключ сохранён — впишите новый, чтобы заменить" : "sk-ant-…"}"></label>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="aiOn" ${c.ai_brand !== false ? "checked" : ""}> распознавать бренд по фото</label>
    <div class="row" style="margin-top:12px"><button class="primary" id="aiSave">Сохранить</button>${c.ai_key_set ? `<button class="danger" id="aiClear">Удалить ключ</button><span class="small ok">● ключ сохранён</span>` : `<span class="small muted">ключа нет</span>`}</div></div>`;
  $("#aiSave").onclick = async () => { if(await act(() => post("/api/config", {ai_key: $("#aiKey").value.trim(), ai_brand: $("#aiOn").checked}), "Сохранено")) drawAi(); };
  const cl = $("#aiClear"); if(cl) cl.onclick = async () => { if(confirm("Удалить ключ Claude API из программы?") && await act(() => post("/api/config", {ai_key_clear: true}), "Ключ удалён")) drawAi(); };
}

// ---------- программа и перенос ----------
async function drawApp(){
  const body = $("#setBody");
  const [au, cfg] = await Promise.all([api("/api/app/autostart").catch(() => ({})), api("/api/config").catch(() => ({})), loadBrowser()]);
  const b = BR || {installed: [], names: {}};
  if(SET_TAB !== "app" || page !== "settings" || !body.isConnected) return;
  body.innerHTML = `<div class="grid2">
    <div class="card"><h3>Запуск</h3>
      <label class="check"><input type="checkbox" id="auOn" ${au.on ? "checked" : ""} ${au.available === false ? "disabled" : ""}> Запускать вместе с Windows (в фоне)</label>
      <div class="small muted" style="margin-top:8px">После включения компьютера программа сама запускает браузер с расширением, и очереди, которые работали до выключения, продолжают выставление. Остановленные кнопкой «Стоп» — не запускаются.
        Окно программы можно закрывать — работа идёт в фоне. Открыть снова: ярлык «Donini Poster».</div>
      <div class="row" style="margin-top:12px"><button class="danger" id="quitBtn">⏻ Выключить программу</button></div></div>
    <div class="card"><h3>Браузер для досок</h3>
      <label class="field">Браузер<select id="brSel"><option value="auto" ${b.choice === "auto" ? "selected" : ""}>основной браузер Windows${b.auto ? " — сейчас " + esc(b.names[b.auto] || b.auto) : ""}</option>
        ${b.installed.map(k => `<option value="${k}" ${b.choice === k ? "selected" : ""}>${esc(b.names[k] || k)}</option>`).join("")}</select></label>
      <div class="small muted" style="margin:8px 0">Сейчас: <b>${esc(b.names[b.current] || b.current || "не найден")}</b>${Q.ext_version ? ` · расширение v${esc(Q.ext_version)}` : ""}. Сменили браузер по умолчанию — программа заметит и предложит перейти.</div>
      <div class="row"><button id="brRestart2">🔄 Перезапустить с расширением</button><button id="extInst">🧩 Поставить расширение</button><button id="extFolder">📂 Папка расширения</button></div></div>
    <div class="card"><h3>📦 Перенос на другой компьютер</h3>
      <div class="small muted">Один файл: сценарии сайтов, шаблоны Donini, очереди и настройки. Товары и входы на сайты не переносятся.</div>
      <label class="check" style="margin:10px 0"><input type="checkbox" id="exSec"> включить пароли и ключи (Telegram, WooCommerce)</label>
      <button class="primary" id="exGo">📦 Сохранить файл переноса</button>
      <div class="small muted" style="margin-top:12px">На новом компьютере: <b>DoniniPoster_Setup.exe</b> → программа откроется → здесь «Загрузить файл».</div>
      <div class="row" style="margin-top:8px"><input type="file" id="reFile" accept=".zip" style="max-width:250px"><button id="reGo">⤵ Загрузить файл переноса или копии</button></div></div>
    <div class="card"><h3>💾 Резервная копия</h3>
      <div class="small muted">Полная копия для себя — со всеми настройками, ключами и очередью (без фото). Перед переустановкой Windows.</div>
      <div class="row" style="margin-top:10px"><button id="bkGo">💾 Сделать резервную копию</button><button id="shareGo" title="Без ваших ключей, очереди и журнала — со сценариями сайтов">📤 Копия для другого человека</button></div></div>
    <div class="card"><h3>⬆ Обновления</h3>
      <div id="updInfo" class="small muted">версия ${esc((Q.version || "").split("-")[0])}</div>
      <label class="field" style="margin-top:10px">Где лежат обновления (GitHub: владелец/репозиторий)<input id="updRepo" placeholder="владелец/репозиторий"></label>
      <div class="row" style="margin-top:10px"><button id="updSave">Сохранить</button><button class="primary" id="updChk">Проверить сейчас</button></div></div>
    <div class="card"><h3>Браузер программы (для сайтов «в фоне»)</h3>
      <label class="field">Какой браузер<select id="sChan"><option value="chrome" ${cfg.browser_channel === "chrome" ? "selected" : ""}>мой Chrome</option><option value="yandex" ${cfg.browser_channel === "yandex" ? "selected" : ""}>Яндекс Браузер</option>
        <option value="msedge" ${cfg.browser_channel === "msedge" ? "selected" : ""}>Microsoft Edge</option><option value="" ${!cfg.browser_channel ? "selected" : ""}>встроенный Chromium</option></select></label>
      <label class="field" style="margin-top:10px">Прокси (необязательно)<input id="sProxy" value="${esc(cfg.proxy || "")}" placeholder="socks5://адрес:порт"></label>
      <div class="row" style="margin-top:10px"><button id="chanSave">Сохранить</button><button id="progBr">Открыть браузер программы (поставить VPN)</button></div></div>
  </div>`;
  $("#auOn").onchange = async e => { const r = await act(() => post("/api/app/autostart", {on: e.target.checked})); if(r && r.ok === false){ toast(r.error, true); e.target.checked = !e.target.checked; } else if(r) toast(e.target.checked ? "Автозапуск включён" : "Автозапуск выключен"); };
  $("#quitBtn").onclick = async () => { if(confirm("Выключить программу? Выставление остановится до следующего запуска.")){ await post("/api/quit").catch(() => {}); document.body.innerHTML = `<div style="margin:auto;padding:40px" class="muted">Программа выключена. Запустить снова — ярлык «Donini Poster».</div>`; } };
  $("#brSel").onchange = async e => { await act(() => post("/api/app/browser", {choice: e.target.value}), "Сохранено"); drawApp(); };
  $("#brRestart2").onclick = restartBrowser;
  $("#extInst").onclick = () => extInstallModal(true);
  $("#extFolder").onclick = () => post("/api/open_folder", {path: "__EXT__"});
  $("#exGo").onclick = () => act(() => post("/api/app/export", {move: true, secrets: $("#exSec").checked}), r => `Сохранено на рабочий стол: ${r.path.split(/[\\/]/).pop()}`);
  $("#bkGo").onclick = () => act(() => post("/api/app/export", {full: true}), r => `Сохранено на рабочий стол: ${r.path.split(/[\\/]/).pop()} — там ваши ключи, никому не передавайте`);
  $("#shareGo").onclick = () => act(() => post("/api/app/export", {}), "На рабочем столе: «DoniniPoster для передачи.zip»");
  $("#reGo").onclick = async () => {
    const f = $("#reFile").files[0]; if(!f) return toast("Выберите файл .zip", true);
    if(!confirm(`Загрузить настройки из «${f.name}»? Программа перезапустится сама.`)) return;
    if(await act(() => api("/api/app/restore", {method: "POST", raw: true, body: f}))){ const old = Q.version; modal(`<div class="row"><div class="spin"></div><b>Загружено — программа перезапускается…</b></div>`); waitRestart(old); }
  };
  const showUpd = (u) => { if(!u) return; $("#updInfo").innerHTML = `Ваша версия: <b>${esc(u.current)}</b>` + (u.ok ? ` · последняя: <b>${esc(u.latest || "—")}</b> — ${u.available ? `<span class="ok">можно обновить</span> <button class="sm go" id="updGo">Обновить</button>` : `<span class="ok">актуальная</span>`}` : ` · <span class="warn">${esc(u.error || "")}</span>`);
    if(document.activeElement !== $("#updRepo")) $("#updRepo").value = u.source || ""; const g = $("#updGo"); if(g) g.onclick = updInstall; };
  showUpd(UPD || await updLoad(false));
  $("#updChk").onclick = async () => { $("#updInfo").textContent = "проверяю…"; showUpd(await updLoad(true)); };
  $("#updSave").onclick = async () => { await act(() => post("/api/update/source", {repo: $("#updRepo").value}), "Сохранено"); showUpd(await updLoad(true)); };
  $("#chanSave").onclick = () => act(() => post("/api/config", {browser_channel: $("#sChan").value, proxy: $("#sProxy").value.trim()}), "Сохранено");
  $("#progBr").onclick = () => act(() => post("/api/browser/open"), "Окно браузера программы открыто — поставьте VPN-расширение и включите его");
}

// ---------- инструкция ----------
function drawHelp(){
  $("#setBody").innerHTML = `<div class="grid2">
    <div class="card"><h3>🚀 Как работать каждый день</h3><ol class="steps">
      <li>Товары: перетащите папки на очередь (или «📥 Добавить товары» — из WeChat и с моего сайта).</li>
      <li>Откройте очередь слева и нажмите <b>▶ Старт</b>. Она будет выставлять товар за товаром на свои сайты.</li>
      <li><b>⏸ Пауза</b> — доделать текущий товар и ждать. <b>■ Стоп</b> — остановить сразу.</li>
      <li>Ошибки видны красным у товара: нажмите — будет причина, скриншот и «↻ Повторить».</li>
      <li>Компьютер выключили — после включения очереди, которые работали, продолжат сами.</li></ol></div>
    <div class="card"><h3>📁 Как называть папки товаров</h3><ol class="steps">
      <li><code>26x16</code> → размер 26*16 cm, <code>21x14 26x16</code> → два размера.</li>
      <li><code>699zl</code> → цена 699 zł (иначе цена по умолчанию очереди).</li>
      <li><code>#83300</code> → свой код вместо автоматического.</li>
      <li>Например: «сумка черная 26x16 699zl». ZIP-архив распакуется сам.</li></ol></div>
    <div class="card"><h3>➕ Новый сайт</h3><ol class="steps">
      <li>Настройки → Сайты → «＋ Добавить сайт».</li><li>«🔑 Войти» — войдите в аккаунт в браузере.</li>
      <li>«● Записать» — выставьте одно объявление как обычно; ничего не публикуется.</li>
      <li>Откройте очередь → «⚙️ Настройки очереди» → отметьте новый сайт.</li></ol></div>
    <div class="card"><h3>🧩 Расширение Donini</h3><ol class="steps">
      <li>Оно заполняет объявления в вашем браузере, где вы уже вошли в аккаунты. Подходят Яндекс, Chrome, Edge, Brave, Opera.</li>
      <li>Программа сама запускает браузер с расширением. Слева внизу — «● Расширение на связи».</li>
      <li>Новый браузер: Настройки → Программа → «🧩 Поставить расширение» — программа откроет нужную страницу и подскажет.</li></ol></div>
    <div class="card"><h3>💻 Новый компьютер / переустановка Windows</h3><ol class="steps">
      <li>До: Настройки → Программа → «📦 Сохранить файл переноса» (или полная «💾 Резервная копия»).</li>
      <li>На новом: запустите <b>DoniniPoster_Setup.exe</b> — всё поставится само.</li>
      <li>Настройки → Программа → «⤵ Загрузить файл».</li><li>Поставьте расширение и войдите на сайты в браузере.</li></ol></div>
    <div class="card"><h3>⌨ Горячие клавиши</h3><ol class="steps">
      <li><code>Ctrl+K</code> или <code>/</code> — поиск товара по коду или названию.</li>
      <li><code>Alt+1…5</code> — очереди сверху по порядку.</li><li><code>Esc</code> — закрыть окно.</li>
      <li>В списке товаров: <code>Shift</code>+галочка — выбрать все между двумя.</li></ol></div></div>`;
}
