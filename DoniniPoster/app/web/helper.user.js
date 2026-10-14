// ==UserScript==
// @name         Donini — помощник для OLX
// @namespace    donini-poster
// @version      1.0
// @description  Берёт следующий товар из программы Donini Poster и заполняет форму объявления OLX. Публикуете вы сами.
// @match        *://*.olx.pl/*
// @match        *://*.olx.ro/*
// @match        *://*.olx.pt/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";
  const API = "http://127.0.0.1:__PORT__";
  const host = location.hostname;
  const SITE = /olx\.pl$/.test(host) ? "olx_pl" : /olx\.ro$/.test(host) ? "olx_ro" : /olx\.pt$/.test(host) ? "olx_pt" : null;
  if (!SITE) return;

  const LEARN_KEY = "donini_fields_" + SITE;
  let current = null;           // текущий товар из программы
  const skipped = new Set();
  let lastField = null;

  // ---------- связь с программой ----------
  function req(method, path, body, type) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: API + path, responseType: type || "json",
        headers: body ? { "Content-Type": "application/json" } : {},
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error((r.response && r.response.detail) || "ошибка " + r.status))),
        onerror: () => reject(new Error("Программа Donini Poster не отвечает. Запустите её (ярлык на рабочем столе).")),
      });
    });
  }

  // ---------- поиск полей ----------
  const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 20;
  function byLabel(re, sel) {
    for (const lab of document.querySelectorAll("label, legend, h3, h4, p, span")) {
      if (!re.test((lab.textContent || "").trim().slice(0, 40))) continue;
      const forId = lab.getAttribute("for");
      let el = forId && document.getElementById(forId);
      if (!el) {
        let box = lab.parentElement;
        for (let i = 0; i < 4 && box && !el; i++, box = box.parentElement) el = box.querySelector(sel);
      }
      if (el && visible(el)) return el;
    }
    return null;
  }
  function learned(kind) {
    try {
      const sel = JSON.parse(localStorage.getItem(LEARN_KEY) || "{}")[kind];
      const el = sel && document.querySelector(sel);
      return visible(el) ? el : null;
    } catch (e) { return null; }
  }
  function learn(kind, el) {
    try {
      const map = JSON.parse(localStorage.getItem(LEARN_KEY) || "{}");
      let sel = null;
      if (el.getAttribute("data-testid")) sel = `[data-testid="${el.getAttribute("data-testid")}"]`;
      else if (el.name) sel = `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      else if (el.id && !/\d{4,}/.test(el.id)) sel = "#" + CSS.escape(el.id);
      if (sel) { map[kind] = sel; localStorage.setItem(LEARN_KEY, JSON.stringify(map)); }
    } catch (e) {}
  }
  const first = (...els) => els.find((e) => visible(e)) || null;
  function findTitle() {
    return learned("title") || first(
      document.querySelector('input[name="title"]'), document.querySelector('[data-testid*="title" i] input'),
      document.querySelector('input[data-testid*="title" i]'), document.querySelector('input[id*="title" i]'),
      byLabel(/tytu[łl]|titlu|t[ií]tulo|title/i, "input"));
  }
  function findBody() {
    return learned("body") || first(
      document.querySelector('textarea[name="description"]'), document.querySelector('textarea[data-testid*="description" i]'),
      document.querySelector('[data-testid*="description" i] textarea'), byLabel(/opis|descri/i, "textarea, [contenteditable=true]"),
      ...Array.from(document.querySelectorAll("textarea")).sort((a, b) => b.clientHeight - a.clientHeight));
  }
  function findPrice() {
    return learned("price") || first(
      document.querySelector('input[name*="price" i]'), document.querySelector('[data-testid*="price" i] input'),
      document.querySelector('input[data-testid*="price" i]'), document.querySelector('input[id*="price" i]'),
      byLabel(/^(cena|pre[țt]|pre[çc]o|price)/i, "input"));
  }
  function findFileInput() {
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    return all.find((i) => /image/.test(i.accept || "")) || all[0] || null;
  }

  // ---------- вставка ----------
  function setValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.innerText = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  async function getPhotoFiles() {
    const files = [];
    for (let i = 0; i < current.photos.length; i++) {
      const blob = await req("GET", current.photos[i], null, "blob");
      files.push(new File([blob], `${current.product.code}_${i + 1}.jpg`, { type: "image/jpeg" }));
    }
    return files;
  }
  async function putPhotos() {
    const input = findFileInput();
    if (!input) { status("Не нашёл, куда загружать фото. Нажмите на сайте кнопку добавления фото и выберите файлы из папки товара.", true); return false; }
    status("Загружаю фото…");
    const files = await getPhotoFiles();
    const sendFiles = (inp, list) => {
      const dt = new DataTransfer();
      list.forEach((f) => dt.items.add(f));
      inp.files = dt.files;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (input.multiple) sendFiles(input, files);
    else for (const f of files) { sendFiles(findFileInput() || input, [f]); await new Promise((r) => setTimeout(r, 1500)); }
    return true;
  }

  async function fillAll() {
    if (!current || !current.product) return;
    const done = [], miss = [];
    const t = findTitle(); if (t) { setValue(t, current.ad.title); done.push("название"); } else miss.push("название");
    const b = findBody(); if (b) { setValue(b, current.ad.body); done.push("описание"); } else miss.push("описание");
    const p = findPrice(); if (p && current.ad.price !== "") { setValue(p, String(current.ad.price)); done.push("цена"); } else miss.push("цена");
    const ph = await putPhotos(); if (ph) done.push(`фото ${current.photos.length}`);
    status(`Вставлено: ${done.join(", ")}.` + (miss.length ? ` Не нашёл: ${miss.join(", ")} — кликните в это поле и нажмите кнопку ниже.` : "") +
           " Проверьте категорию и нажмите «Dodaj/Publică/Publicar» на сайте.", miss.length > 0);
  }
  function fillOne(kind) {
    if (!current || !current.product) return;
    const el = lastField && document.contains(lastField) ? lastField : null;
    if (kind === "photos") { putPhotos().then((ok) => ok && status("Фото загружены")); return; }
    if (!el) { status("Сначала кликните в поле на сайте, потом нажмите кнопку.", true); return; }
    const value = kind === "title" ? current.ad.title : kind === "body" ? current.ad.body : String(current.ad.price);
    setValue(el, value);
    learn(kind, el); // запомним это поле на будущее
    status("Вставлено. Это поле запомнено — дальше «Заполнить всё» найдёт его само.");
  }

  // ---------- панель ----------
  const hostEl = document.createElement("div");
  hostEl.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const root = hostEl.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .p{width:290px;background:#1c1510;color:#f1e9dd;border-radius:12px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4)}
      .h{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px}
      .g{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}
      button{border:0;border-radius:8px;padding:8px;font:inherit;cursor:pointer;background:#3a3025;color:#f1e9dd}
      button.a{background:#d18b56;color:#1c1108;font-weight:700}
      button.ok{background:#3f7a52;color:#fff;font-weight:700}
      .w{width:100%;margin-top:6px}
      .info{background:#2a2119;border-radius:8px;padding:8px;line-height:1.4}
      .code{font-family:Consolas,monospace;font-size:15px;font-weight:700;color:#d18b56}
      small{color:#ab9d8c;display:block;line-height:1.4;margin-top:6px}
      small.err{color:#ef8a72}
      .mini{padding:2px 8px}
    </style>
    <div class="p">
      <div class="h"><span>Donini → ${host.replace("www.", "")}</span><button class="mini" id="mn">—</button></div>
      <div id="body">
        <div class="info" id="info">Загружаю товар из программы…</div>
        <button class="a w" id="fill">Заполнить всё</button>
        <div class="g">
          <button data-k="title">Название</button><button data-k="body">Описание</button>
          <button data-k="price">Цена</button><button data-k="photos">Фото</button>
        </div>
        <button class="ok w" id="done">✓ Выставил — следующий товар</button>
        <div class="g"><button id="skip">Пропустить</button><button id="reload">Обновить</button></div>
        <small id="st">Откройте форму нового объявления и нажмите «Заполнить всё». Публикуете вы сами.</small>
      </div>
    </div>`;
  const $ = (id) => root.getElementById(id);
  function status(text, err) { $("st").textContent = text; $("st").className = err ? "err" : ""; }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  async function loadNext() {
    try {
      current = await req("GET", `/api/helper/next?site=${SITE}&skip=${Array.from(skipped).join(",")}`);
      if (!current.product) {
        $("info").innerHTML = `Для ${esc(current.site)} в очереди нет товаров. 🎉`;
        return;
      }
      $("info").innerHTML = `<span class="code">${esc(current.product.code)}</span> · ${esc(current.product.name)}<br>
        ${esc(current.ad.title)}<br>цена: <b>${esc(current.ad.price)} ${esc(current.ad.currency)}</b> · фото: ${current.photos.length}<br>
        <small>осталось в очереди: ${current.left}</small>`;
    } catch (e) {
      $("info").textContent = e.message;
    }
  }

  root.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
  $("fill").onclick = () => fillAll().catch((e) => status(e.message, true));
  root.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => fillOne(b.dataset.k)));
  $("done").onclick = async () => {
    if (!current || !current.product) return;
    try {
      await req("POST", "/api/helper/done", { pid: current.product.id, site: SITE, url: location.href });
      status(`Товар ${current.product.code} отмечен как выставленный. Откройте форму нового объявления.`);
      await loadNext();
    } catch (e) { status(e.message, true); }
  };
  $("skip").onclick = async () => {
    if (!current || !current.product) return;
    skipped.add(current.product.id);
    status("Пропущен на этот раз (останется в очереди).");
    await loadNext();
  };
  $("reload").onclick = loadNext;
  $("mn").onclick = () => { const b = $("body"); b.style.display = b.style.display === "none" ? "" : "none"; };

  document.addEventListener("focusin", (e) => {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && el !== hostEl) lastField = el;
  }, true);

  document.body.appendChild(hostEl);
  loadNext();
})();
