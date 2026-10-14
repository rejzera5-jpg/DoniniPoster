const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const main = document.getElementById("main");
let S = null, pos = 0, A = null, B = null, W = null, posSet = false;

async function load() {
  window.__pub = await send({ type: "pubGet" });
  S = await send({ type: "popupState" });
  A = await send({ type: "autoState" });
  B = await send({ type: "batchState" });
  W = await send({ type: "wooState" });
  if (!S || S.ok === false || !S.products) {
    main.innerHTML = `<div class="card"><b class="err">Программа Donini Poster не отвечает.</b>
      <div class="muted" style="margin-top:6px">Запустите её ярлыком «Donini Poster» на рабочем столе и откройте это окно снова.</div>
      <div class="row" style="margin-top:10px"><span class="muted">Порт:</span><input id="port" value="8765" style="width:70px"><button class="s" id="savePort">Сохранить</button></div></div>`;
    document.getElementById("savePort").onclick = async () => { await send({ type: "setPort", port: Number(document.getElementById("port").value) || 8765 }); load(); };
    return;
  }
  render();
}

function render() {
  // товары для своего сайта загружает программа (без браузера) — здесь только доски
  const ps = S.products.filter((p) => p.line !== "site");
  document.getElementById("left").textContent = ps.length ? `в очереди: ${ps.length}` : "";
  let html = "";
  // ---- свой сайт doninisklep.com ----
  if (W && W.woo) {
    const ready = W.woo.url && W.woo.ck;
    html += `<div class="card${W.running ? " auto" : ""}"><h4>🌐 Мой сайт — doninisklep.com</h4>
      <div class="muted">${ready ? `В «Очереди сайта»: <b>${W.left}</b> · загружено: <b>${W.done}</b>${W.errors ? ` · <span class="err">ошибок: ${W.errors}</span>` : ""}` : "Сначала подключите сайт: окно программы → «Настройки» → «🌐 Мой сайт»."}</div>
      ${W.running && W.status ? `<div class="muted" style="margin-top:2px">Сейчас: ${esc(W.status)}</div>` : ""}
      <div class="row" style="margin-top:8px">
        ${ready ? `<button class="w${W.running ? " s" : ""}" id="wooRun" style="flex:1">${W.running ? "■ Остановить загрузку" : "▶ Загружать на сайт"}</button>` : ""}
        <button class="s" id="wooFolder" title="Открыть папку «Очередь сайта»">📂 Очередь сайта</button>
      </div>
      <div class="muted" style="margin-top:4px">Идёт в программе, в фоне — без браузера и параллельно с досками. Уведомления — в Telegram.</div></div>`;
  }
  // ---- режим публикации: я сам жму «Опубликовать» / программа публикует сама ----
  const P = window.__pub || { mode: "manual", interval: 90 };
  html += `<div class="card${P.mode === "auto" ? " auto" : ""}"><h4>Публикация</h4>
    <div class="row">
      <button class="${P.mode === "manual" ? "" : "s"}" id="pubManual" style="flex:1">🙋 С моим участием</button>
      <button class="${P.mode === "auto" ? "" : "s"}" id="pubAuto" style="flex:1">🤖 Без меня</button>
    </div>
    <div class="muted" style="margin-top:6px">${P.mode === "auto"
      ? "Программа сама жмёт «Опубликовать». Если на сайте что-то сломалось — сайт пропускается, вам приходит сообщение в Telegram."
      : "Программа заполняет, а «Опубликовать» нажимаете вы."}</div>
    <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #e3dbcd"><b>⏱ Интервал выставления</b>
      <div class="row" style="margin-top:6px"><span class="muted">Пауза между товарами:</span>
        <input id="pubInterval" type="number" min="0" max="60" step="0.5" value="${esc(String((P.interval || 0) / 60))}" style="width:60px"><span class="muted">мин</span></div>
      <div class="row" style="margin-top:4px"><span class="muted">Случайный разброс: ±</span>
        <input id="pubJitter" type="number" min="0" max="90" step="5" value="${esc(String(P.jitter ?? 20))}" style="width:52px"><span class="muted">%</span></div>
      <label class="row muted" style="margin-top:4px;cursor:pointer"><input type="checkbox" id="pubAlways" ${P.always ? "checked" : ""}> паузу делать и в режиме «с моим участием»</label>
      <label class="row" style="margin-top:8px;cursor:pointer"><input type="checkbox" id="pubBg" ${P.background !== false ? "checked" : ""}> 🪟 Работать в фоне — не переключать меня на вкладки</label>
      <div class="muted" style="margin-top:2px">Выставление идёт в отдельном окне Chrome позади вашего. Не сворачивайте это окно — свёрнутые вкладки сайты почти не обрабатывают.</div>
      <div class="muted" style="margin-top:4px">Например, 1.5 мин ±20% — каждый раз от 1:12 до 1:48, чтобы сайты не видели одинаковых промежутков.</div></div></div>`;
  // ---- пакетный режим: линия → сайт → сколько штук ----
  if (B && B.batch) {
    const b = B.batch;
    html += `<div class="card auto"><b>📦 Пачка: ${esc(b.lineName)} → ${esc(b.siteName)}</b>
      <div class="muted" style="margin-top:4px">Выставлено ${b.done || 0} из ${b.target}${b.skipped ? `, пропущено ${b.skipped}` : ""}.
      Следующий товар откроется там же сам. Работает одновременно с авто-режимом.</div>
      <div class="row" style="margin-top:6px"><span class="muted">Пауза между товарами:</span><input id="bPause" type="number" min="0" max="3600" value="${esc(String(P.batchPause ?? 15))}" style="width:60px"><span class="muted">сек</span></div>
      <button class="w s" id="batchStop">■ Остановить пачку</button></div>`;
  } else if ((S.lines || []).length) {
    const lines = S.lines.filter((l) => (l.sites || []).length && l.id !== "site");
    const bl = localStorage.getItem("bLine") || (lines[0] && lines[0].id);
    const line = lines.find((l) => l.id === bl) || lines[0];
    if (line) {
      const left = (sid) => ps.filter((p) => p.line === line.id && p.sites.some((x) => x.id === sid)).length;
      const siteName = (sid) => ((S.sites || []).find((x) => x.id === sid) || {}).name || sid;
      const bs = localStorage.getItem("bSite");
      const firstWithWork = line.sites.find((sid) => left(sid) > 0) || line.sites[0];
      const curSite = line.sites.includes(bs) && left(bs) > 0 ? bs : firstWithWork;
      html += `<div class="card"><h4>📦 Выставить пачкой на один сайт</h4>
        <div class="row"><span class="muted" style="width:62px">Товар:</span><select id="bLine" style="flex:1">${lines.map((l) => `<option value="${esc(l.id)}"${l.id === line.id ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
        <div class="row" style="margin-top:6px"><span class="muted" style="width:62px">Сайт:</span><select id="bSite" style="flex:1">${line.sites.map((sid) => `<option value="${esc(sid)}"${sid === curSite ? " selected" : ""}>${esc(siteName(sid))} — ждут: ${left(sid)}</option>`).join("")}</select></div>
        <div class="row" style="margin-top:6px"><span class="muted" style="width:62px">Сколько:</span><input id="bCount" type="number" min="1" value="${esc(localStorage.getItem("bCount_" + line.id) || 10)}" style="width:70px"><span class="muted">шт.</span></div>
        <div class="row" style="margin-top:6px"><span class="muted">Пауза между товарами:</span><input id="bPause" type="number" min="0" max="3600" value="${esc(String(P.batchPause ?? 15))}" style="width:60px"><span class="muted">сек</span></div>
        <button class="w" id="batchGo">▶ Выставить пачкой</button>
        <div class="muted" style="margin-top:6px">Откроется одна вкладка сайта. После публикации (или «Пропустить этот сайт») там же откроется следующий товар — и так до нужного количества.</div></div>`;
    }
  }
  if (A && A.auto) {
    const wu = A.auto.waitUntil && A.auto.waitFor === A.auto.pid ? A.auto.waitUntil : 0;
    html += `<div class="card auto"><b>▶ Авто-режим включён</b>
      <div class="muted" style="margin-top:4px">Товаров открыто: ${A.auto.count || 1}.</div>
      <div id="pauseLine" data-until="${wu}" style="margin-top:6px;font-weight:600"></div>
      <div class="muted" style="margin-top:4px">${(window.__pub || {}).mode === "auto"
        ? "Программа сама публикует; после каждого товара — пауза, потом следующий откроется сам. Ничего не нажимайте."
        : "Опубликуйте объявление на каждой вкладке (или «Пропустить этот сайт», или закройте вкладку) — следующий товар откроется сам."}</div>
      <button class="w s" id="autoStop">■ Остановить авто-режим</button></div>`;
  }
  if (!ps.length) {
    html += `<div class="card"><b>Очередь пуста 🎉</b><div class="muted" style="margin-top:6px">Для сайтов «в моём браузере» нет товаров. Скачайте каталог в папку очереди программы.</div></div>`;
  } else {
    if (!posSet) {
      // сразу показываем первый товар, который ещё не открыт во вкладках
      // первым показываем товар, который ещё не открыт и ждёт больше всего сайтов (полностью новый)
      const open = (A && A.openPids) || [];
      let best = -1;
      ps.forEach((p, k) => { if (!open.includes(p.id) && (best < 0 || p.sites.length > ps[best].sites.length)) best = k; });
      pos = best >= 0 ? best : 0;
      posSet = true;
    }
    pos = Math.min(pos, ps.length - 1);
    const p = ps[pos];
    html += `<div class="card">
      <div class="row"><img src="${esc(S.base + p.thumb)}"><div style="flex:1;min-width:0">
        <div class="code">${esc(p.code)}</div><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
        <div class="muted">${esc(p.size)} · ${esc(p.price)} зл · фото: ${p.photos}</div></div></div>
      <div class="sites">${p.sites.map((s) => `<label><input type="checkbox" data-s="${esc(s.id)}" checked> ${esc(s.name)}${s.has_steps ? "" : " ⚠️"}</label>`).join("")}</div>
      ${p.sites.some((s) => !s.has_steps) ? `<div class="muted">⚠️ — сценарий не записан, там заполните кнопками панели или запишите ниже.</div>` : ""}
      <button class="w" id="auto" title="После публикации на всех вкладках сам откроет следующий товар">▶ Выставлять подряд (авто)</button>
      <button class="w s" id="go">Только этот товар</button>
      <div class="row" style="margin-top:6px"><button class="s" id="prev" ${pos ? "" : "disabled"}>←</button>
        <span class="muted" style="flex:1;text-align:center">товар ${pos + 1} из ${ps.length}</span>
        <button class="s" id="next" ${pos < ps.length - 1 ? "" : "disabled"}>→</button></div>
      <div class="muted" style="margin-top:8px">Откроется окно с вкладками сайтов, формы заполнятся сами. На каждой вкладке проверьте и нажмите «Опубликовать».</div>
    </div>`;
  }
  if ((S.missing && S.missing.length) || (S.disabled && S.disabled.length)) {
    html += `<div class="card muted">${S.missing && S.missing.length ? `Не отмечены ни в одной линии товара (программа → «Линии товара»): <b>${esc(S.missing.join(", "))}</b>.<br>` : ""}
      ${S.disabled && S.disabled.length ? `Выключены (программа → «Сайты» → «вкл»): <b>${esc(S.disabled.join(", "))}</b>.` : ""}</div>`;
  }
  const lines = S.lines || [];
  // вид товара (линия) для записи; «Сумки» (шаблон сумок) = уже записанные на сайтах сценарии
  const bagLine = lines.find((l) => l.template === "bags");
  let recLine = localStorage.getItem("recLine");
  if (!lines.some((l) => l.id === recLine)) recLine = bagLine ? bagLine.id : (lines[0] ? lines[0].id : "default");
  const curL = lines.find((l) => l.id === recLine);
  const stepsFor = (site) => {
    const own = (site.by_line || {})[recLine] || 0;
    const def = (site.by_line || {}).default ?? site.steps ?? 0;
    if (own) return ` (${own} шагов)`;
    if (curL && curL === bagLine && def) return ` (${def} шагов)`;
    if (def) return ` — не записан (пока возьмётся сценарий сумок)`;
    return " — не записан";
  };
  const siteList = curL && curL.sites && curL.sites.length
    ? [...S.sites.filter((x) => curL.sites.includes(x.id)), ...S.sites.filter((x) => !curL.sites.includes(x.id))]
    : S.sites;
  html += `<div class="card"><h4>Записать сценарий сайта</h4>
    <div class="muted">Для каждого вида товара — свой сценарий: на сайте выбираете свою категорию и пункты.
    Выставите объявление как обычно — расширение запомнит шаги. Ничего не публикуется.</div>
    ${lines.length ? "" : `<div class="err" style="margin-top:6px">Программа запущена старой версией — перезапустите её через Запуск.bat, тогда здесь появятся виды товара.</div>`}
    <div class="row" style="margin-top:8px"><span class="muted" style="width:62px">Товар:</span>
      <select id="recLine" style="flex:1">${lines.map((l) => `<option value="${esc(l.id)}"${recLine === l.id ? " selected" : ""}>${esc(l.name)}</option>`).join("")}
      <option value="__add">➕ Добавить вид товара…</option></select></div>
    <div class="row" style="margin-top:6px"><span class="muted" style="width:62px">Сайт:</span>
      <select id="recSite" style="flex:1">${siteList.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${curL && curL.sites && !curL.sites.includes(x.id) ? " (не в этой линии)" : ""}${stepsFor(x)}</option>`).join("")}</select></div>
    <button class="w s" id="rec">● Записать</button></div>`;
  html += `<div class="card"><button class="w s" id="mgrSync">🔄 Синхронизировать с Donini Manager</button>
    <div class="muted" id="mgrSyncSt" style="margin-top:6px">Берёт шаблоны и правки названий из открытого Donini Manager.</div></div>`;
  html += `<div class="card"><a href="${esc(S.base)}/" target="_blank">Открыть программу</a></div>`;
  main.innerHTML = html;
  const pl = document.getElementById("pauseLine");
  if (pl) {
    const tick = () => {
      const left = Math.round((Number(pl.dataset.until) - Date.now()) / 1000);
      pl.textContent = left > 0 ? `⏳ Пауза: следующий товар откроется через ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "⚙️ Идёт выставление текущего товара…";
    };
    tick(); clearInterval(window.__pt); window.__pt = setInterval(tick, 1000);
  }
  const savePub = async (patch) => { window.__pub = await send({ type: "pubSet", ...patch }); render(); };
  document.getElementById("pubManual").onclick = () => savePub({ mode: "manual" });
  document.getElementById("pubAuto").onclick = () => savePub({ mode: "auto" });
  document.getElementById("pubInterval").onchange = (e) => savePub({ interval: Math.max(0, Math.round((Number(String(e.target.value).replace(",", ".")) || 0) * 60)) });
  document.getElementById("pubJitter").onchange = (e) => savePub({ jitter: Math.max(0, Math.min(90, Number(e.target.value) || 0)) });
  document.getElementById("pubAlways").onchange = (e) => savePub({ always: e.target.checked });
  document.getElementById("pubBg").onchange = (e) => savePub({ background: e.target.checked });

  const go = document.getElementById("go");
  if (go) go.onclick = async () => {
    const sites = Array.from(document.querySelectorAll("[data-s]")).filter((c) => c.checked).map((c) => c.dataset.s);
    if (!sites.length) return;
    go.disabled = true; go.textContent = "Открываю…";
    const r = await send({ type: "start", pid: ps[pos].id, sites });
    if (r && r.ok) window.close(); else { go.disabled = false; go.textContent = "Ошибка: " + ((r && r.error) || "нет связи"); }
  };
  const ms = document.getElementById("mgrSync");
  if (ms) ms.onclick = async () => {
    ms.disabled = true; ms.textContent = "Синхронизирую…";
    const r = await send({ type: "managerSyncNow" });
    ms.disabled = false; ms.textContent = "🔄 Синхронизировать с Donini Manager";
    document.getElementById("mgrSyncSt").innerHTML = r && r.ok
      ? `<span style="color:#3f7a52">✓ Готово: шаблонов ${r.templates}, правок названий ${r.titles}, описаний ${r.bodies}.</span>`
      : `<span class="err">${esc((r && r.error) || "не получилось")}</span>`;
  };
  const bLineSel = document.getElementById("bLine");
  if (bLineSel) bLineSel.onchange = (e) => { try { localStorage.setItem("bLine", e.target.value); } catch (er) {} render(); };
  const bSiteSel = document.getElementById("bSite");
  if (bSiteSel) bSiteSel.onchange = (e) => { try { localStorage.setItem("bSite", e.target.value); } catch (er) {} };
  const bGo = document.getElementById("batchGo");
  if (bGo) bGo.onclick = async () => {
    const line = document.getElementById("bLine").value, site = document.getElementById("bSite").value;
    const n = Number(document.getElementById("bCount").value) || 10;
    try { localStorage.setItem("bCount_" + line, String(n)); localStorage.setItem("bSite", site); } catch (er) {}
    bGo.disabled = true; bGo.textContent = "Открываю…";
    const r = await send({ type: "batchStart", line, site, target: n });
    if (r && r.ok) window.close(); else { bGo.disabled = false; bGo.textContent = (r && r.error) || "Ошибка: нет связи с программой"; }
  };
  const bPause = document.getElementById("bPause");
  if (bPause) bPause.onchange = (e) => savePub({ batchPause: Math.max(0, Math.round(Number(e.target.value) || 0)) });
  const wRun = document.getElementById("wooRun");
  if (wRun) wRun.onclick = async () => {
    wRun.disabled = true;
    const r = await send({ type: "wooRun", on: !(W && W.running) });
    if (r && r.ok === false) alert(r.error || "Не получилось");
    load();
  };
  const wFolder = document.getElementById("wooFolder");
  if (wFolder) wFolder.onclick = () => send({ type: "wooFolder" });
  const bStop = document.getElementById("batchStop");
  if (bStop) bStop.onclick = async () => { await send({ type: "batchStop" }); load(); };
  const autoBtn = document.getElementById("auto");
  if (autoBtn) autoBtn.onclick = async () => {
    const sites = Array.from(document.querySelectorAll("[data-s]")).filter((c) => c.checked).map((c) => c.dataset.s);
    if (!sites.length) return;
    autoBtn.disabled = true; autoBtn.textContent = "Открываю…";
    const r = await send({ type: "autoStart", pid: ps[pos].id, sites });
    if (r && r.ok) window.close(); else { autoBtn.disabled = false; autoBtn.textContent = "Ошибка: " + ((r && r.error) || "нет связи"); }
  };
  const stopBtn = document.getElementById("autoStop");
  if (stopBtn) stopBtn.onclick = async () => { await send({ type: "autoStop" }); load(); };
  const prev = document.getElementById("prev"), next = document.getElementById("next");
  if (prev) prev.onclick = () => { pos--; render(); };
  if (next) next.onclick = () => { pos++; render(); };
  document.getElementById("recLine").onchange = (e) => {
    if (e.target.value === "__add") {
      // новый вид товара (обувь и т.п.) добавляется в программе: вкладка «Линии товара»
      chrome.tabs.create({ url: S.base + "/#lines" });
      window.close();
      return;
    }
    try { localStorage.setItem("recLine", e.target.value); } catch (er) {}
    const keep = document.getElementById("recSite").value;
    render();
    const sel = document.getElementById("recSite");
    if (Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
  };
  document.getElementById("rec").onclick = async () => {
    const lv = document.getElementById("recLine").value;
    const r = await send({ type: "record", site: document.getElementById("recSite").value, line: lv && lv !== "__add" ? lv : "default" });
    if (r && r.ok) window.close(); else alert((r && r.error) || "Не получилось начать запись");
  };
}
load();
