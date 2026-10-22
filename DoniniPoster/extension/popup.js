// Окошко расширения: те же очереди и кнопки Старт / Пауза / Стоп, что в окне программы (команды идут в программу),
// запись сценария сайта и синхронизация с Donini Manager. Всё остальное — в окне программы.
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const main = document.getElementById("main");
const STATE = { run: "работает", pause: "пауза", stop: "остановлена" };
let BASE = "http://127.0.0.1:8765", Q = null;

async function prog(path, body) {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || r.statusText);
  return d;
}
async function load() {
  const { port = 8765 } = await chrome.storage.local.get("port");
  BASE = `http://127.0.0.1:${port}`;
  try { Q = await prog("/api/queues"); } catch (e) { Q = null; }
  if (!Q) {
    main.innerHTML = `<div class="card"><b class="err">Программа Donini Poster не отвечает.</b>
      <div class="muted" style="margin-top:6px">Запустите её ярлыком «Donini Poster» на рабочем столе и откройте это окошко снова.</div>
      <div class="row" style="margin-top:10px"><span class="muted">Порт:</span><input id="port" value="${esc(port)}" style="width:70px"><button id="savePort">Сохранить</button></div></div>`;
    document.getElementById("savePort").onclick = async () => { await send({ type: "setPort", port: Number(document.getElementById("port").value) || 8765 }); load(); };
    return;
  }
  render();
}
function render() {
  const wait = Q.queues.reduce((a, q) => a + q.waiting, 0);
  document.getElementById("left").textContent = wait ? `ждут: ${wait}` : "";
  const qrow = (q) => {
    const d = q.run === "run" ? (q.working || q.id === "site" ? "run" : "wait") : q.run === "pause" ? "pause" : "";
    return `<div class="q" data-q="${esc(q.id)}"><i class="dot ${d}"></i>
      <div class="nm">${esc(q.name)} <span class="n${q.errors ? " e" : ""}">${q.waiting}</span><small>${STATE[q.run]}${q.errors ? ` · ошибок ${q.errors}` : ""}</small></div>
      <button class="go${q.run === "run" ? " cur" : ""}" data-r="run" title="Старт">▶</button>
      <button class="pa${q.run === "pause" ? " cur" : ""}" data-r="pause" title="Пауза — доделать текущий товар">⏸</button>
      <button class="st${q.run === "stop" ? " cur" : ""}" data-r="stop" title="Стоп">■</button></div>`;
  };
  const mainQ = Q.queues.filter((q) => q.group === "main"), more = Q.queues.filter((q) => q.group !== "main" && (q.waiting || q.run !== "stop"));
  let html = `<div class="card"><h4>Очереди</h4>${mainQ.map(qrow).join("")}${more.map(qrow).join("")}
    <div class="muted" style="margin-top:6px">Те же кнопки, что в окне программы. Пауза — текущий товар доделается; Стоп — вкладки закроются сразу.</div></div>`;
  if (Q.manual_auto) html += `<div class="card"><b>Идёт выставление по старой кнопке</b><div class="muted" style="margin-top:4px">Остановите его — дальше управляйте очередями кнопками выше.</div>
    <button class="w st" id="autoStop">■ Остановить</button></div>`;
  html += `<div class="card"><h4>● Записать сценарий сайта</h4>
    <div class="row"><select id="recSite" style="flex:1">${Q.sites.filter((s) => s.type === "ext").map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select></div>
    <div class="row" style="margin-top:6px"><select id="recLine" style="flex:1"><option value="default">общий — для всех очередей</option>
      ${Q.queues.filter((q) => q.id !== "site").map((q) => `<option value="${esc(q.id)}">только для «${esc(q.name)}»</option>`).join("")}</select></div>
    <button class="w" id="rec">● Записать</button>
    <div class="muted" style="margin-top:6px">Выставьте объявление как обычно — расширение запомнит шаги. Ничего не публикуется.</div></div>`;
  html += `<div class="card"><div class="row"><button class="primary" id="open" style="flex:1">Открыть Donini Poster</button><button id="mgrSync" title="Взять шаблоны и правки из открытого Donini Manager">🔄 Manager</button></div>
    <div class="muted" id="mgrSt" style="margin-top:6px"></div></div>`;
  main.innerHTML = html;
  try { const r = localStorage.getItem("recLine"); if (r) document.getElementById("recLine").value = r; } catch (e) {}
  main.querySelectorAll("[data-r]").forEach((b) => b.onclick = async () => {
    if (b.classList.contains("cur")) return;
    const q = Q.queues.find((x) => x.id === b.closest("[data-q]").dataset.q), state = b.dataset.r;
    let together = false;
    if (state === "run" && q.id !== "site") {
      const others = Q.queues.filter((o) => o.id !== "site" && o.id !== q.id && o.run === "run");
      if (others.length) together = !confirm(`Сейчас выставляется «${others.map((o) => o.name).join(", ")}».\n\nОК — переключиться на «${q.name}» (остальные на паузу).\nОтмена — запустить вместе.`);
    }
    b.disabled = true;
    try { await prog(`/api/queue/${encodeURIComponent(q.id)}/run`, { state, together }); } catch (e) { alert(e.message); }
    load();
  });
  const as = document.getElementById("autoStop"); if (as) as.onclick = async () => { await send({ type: "autoStop" }); load(); };
  document.getElementById("recLine").onchange = (e) => { try { localStorage.setItem("recLine", e.target.value); } catch (er) {} };
  document.getElementById("rec").onclick = async () => {
    const r = await send({ type: "record", site: document.getElementById("recSite").value, line: document.getElementById("recLine").value || "default" });
    if (r && r.ok) window.close(); else alert((r && r.error) || "Не получилось начать запись");
  };
  document.getElementById("open").onclick = async () => {
    try { await prog("/api/app/show_window", {}); } catch (e) { chrome.tabs.create({ url: BASE + "/" }); }
    window.close();
  };
  document.getElementById("mgrSync").onclick = async () => {
    const st = document.getElementById("mgrSt"); st.textContent = "Синхронизирую…";
    const r = await send({ type: "managerSyncNow" });
    st.innerHTML = r && r.ok ? `<span class="ok">✓ Шаблонов ${r.templates}, правок названий ${r.titles}, описаний ${r.bodies}</span>` : `<span class="err">${esc((r && r.error) || "не получилось")}</span>`;
  };
}
load();
setInterval(() => { if (!document.querySelector("select:focus")) load(); }, 4000);
