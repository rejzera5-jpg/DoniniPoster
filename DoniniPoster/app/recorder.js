// Панель записи сценария. Внедряется на каждую страницу во время записи.
(() => {
  if (window.__dpRecorderInstalled) return;
  window.__dpRecorderInstalled = true;

  const PANEL_ID = "__dp_rec_panel";
  const IS_TOP = window === window.top;
  let publishNext = false;
  const deep = (ev) => (ev.composedPath && ev.composedPath()[0]) || ev.target; // настоящий элемент (в т.ч. внутри shadow DOM)

  const isPanel = (el) => {
    // панель живёт в shadow DOM — поднимаемся и через границу shadow
    let n = el;
    while (n) { if (n.id === PANEL_ID) return true; n = n.parentNode || n.host; }
    return false;
  };
  // кнопки публикации: во время записи их НИКОГДА не нажимаем, только запоминаем
  const PUBLISH_RE = /zveřejn|opublikuj|dodaj ogłoszenie|veröffentlich|anzeige aufgeben|plaats advertentie|plaatsen|feladás|hirdetés feladása|publicar|publică|publish/i;
  const isTextField = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "number", "tel", "email", "search", "url", "password", ""].includes(t);
    }
    return false;
  };
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
  const looksGenerated = (s) => !s || s.length > 40 || /\d{4,}/.test(s) || /^[a-f0-9-]{16,}$/i.test(s) || /:r\d|^ember\d|^react/i.test(s);
  const cleanText = (t) => (t || "").replace(/\s+/g, " ").trim();

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      if (cur.id && !looksGenerated(cur.id)) { parts.unshift("#" + cssEsc(cur.id)); break; }
      let sel = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = parent;
    }
    return parts.join(" > ");
  }

  function selectorsFor(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    for (const a of ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id"]) {
      const v = el.getAttribute(a);
      if (v) out.push(`[${a}="${cssEsc(v)}"]`);
    }
    if (el.id && !looksGenerated(el.id)) out.push("#" + cssEsc(el.id));
    const name = el.getAttribute("name");
    if (name && !looksGenerated(name)) out.push(`${tag}[name="${cssEsc(name)}"]`);
    const aria = el.getAttribute("aria-label");
    if (aria) out.push(`${tag}[aria-label="${cssEsc(aria)}"]`);
    const ph = el.getAttribute("placeholder");
    if (ph) out.push(`${tag}[placeholder="${cssEsc(ph)}"]`);
    const txt = cleanText(el.innerText || el.textContent);
    if (txt && txt.length <= 50 && !isTextField(el) && tag !== "select") {
      out.push(`${tag}:has-text("${txt.replace(/"/g, '\\"')}")`);
      out.push(`text="${txt.replace(/"/g, '\\"')}"`);
    }
    out.push(cssPath(el));
    return Array.from(new Set(out));
  }

  function clickable(el) {
    // поднимаемся к «настоящей» кнопке/ссылке, если кликнули по иконке внутри
    const c = el.closest("button, a, label, [role=button], [role=option], [role=menuitem], [role=tab], [role=radio], [role=checkbox], li, input");
    return c || el;
  }

  function send(step) {
    try { window.__dpRecord(step).then((n) => setCount(n)); } catch (e) {}
  }

  // ---- клики ----
  document.addEventListener("click", (ev) => {
    const target = deep(ev);
    if (!ev.isTrusted) return; // клики, которые делает сам сайт своим кодом, не записываем
    if (!target || isPanel(target)) return;
    if (isTextField(target) || target.tagName === "SELECT" || target.tagName === "OPTION") return;
    const el = clickable(target);
    if (el.tagName === "INPUT" && isTextField(el)) return;
    if (el === target && !publishNext && !el.onclick && getComputedStyle(el).cursor !== "pointer"
        && cleanText(el.innerText).length > 40) return; // клик по пустому месту формы — не шаг
    const label = cleanText(el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 60);
    const looksPublish = (el.tagName === "BUTTON" || el.type === "submit" || el.getAttribute("role") === "button")
                         && label.length < 40 && PUBLISH_RE.test(label);
    if (looksPublish) publishNext = true;
    const step = { action: publishNext ? "publish" : "click", selectors: selectorsFor(el), label };
    if (publishNext) {
      // кнопку «Опубликовать» только запоминаем, но НЕ нажимаем — тестовое объявление не выйдет
      ev.preventDefault();
      ev.stopImmediatePropagation();
      publishNext = false;
      updatePublishBtn();
      if (publishBtn) { publishBtn.textContent = "✔ Кнопка запомнена (не нажата). Жмите «Готово»"; publishBtn.style.background = "#3f7a52"; }
    }
    send(step);
  }, true);

  // ---- запоминаем последнее поле ввода ----
  document.addEventListener("focusin", (ev) => {
    const el = deep(ev);
    if (!isPanel(el) && isTextField(el)) {
      try { window.__dpFocus({ selectors: selectorsFor(el), frame: IS_TOP ? null : location.href }); } catch (e) {}
    }
  }, true);

  // ---- ручной ввод текста / выбор в списке ----
  document.addEventListener("change", (ev) => {
    const el = deep(ev);
    if (!el || isPanel(el) || !ev.isTrusted) return;
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      send({ action: "select", selectors: selectorsFor(el), value: el.value, label: opt ? cleanText(opt.text) : "" });
    } else if (isTextField(el)) {
      send({ action: "fill", selectors: selectorsFor(el), value: el.value, label: "свой текст" });
    }
  }, true);
  document.addEventListener("focusout", (ev) => {
    const el = deep(ev);
    if (el && el.isContentEditable && !isPanel(el)) {
      const v = el.innerText.trim();
      if (v) send({ action: "fill", selectors: selectorsFor(el), value: v, label: "свой текст" });
    }
  }, true);

  // ---- панель ----
  let countEl, publishBtn;
  function setCount(n) { if (countEl) countEl.textContent = n; }
  function updatePublishBtn() {
    if (!publishBtn) return;
    publishBtn.textContent = publishNext ? "✔ Теперь нажмите «Опубликовать» на сайте" : "Следующий клик = «Опубликовать»";
    publishBtn.style.background = publishNext ? "#3f7a52" : "#3a3025";
  }

  async function fillVar(varName) {
    // текст вставляет программа прямо в поле, где стоит курсор (работает и в редакторах, и во фреймах)
    const res = await window.__dpFill(varName);
    if (res && !res.ok) alert(res.msg);
  }

  function buildPanel() {
    if (!IS_TOP || document.getElementById(PANEL_ID) || !document.body) return;
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .p{width:270px;background:#1c1510;color:#f1e9dd;border-radius:12px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4)}
        .h{display:flex;justify-content:space-between;font-weight:700;margin-bottom:8px}
        .g{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}
        button{border:0;border-radius:8px;padding:8px;font:inherit;cursor:pointer;background:#3a3025;color:#f1e9dd}
        button.a{background:#d18b56;color:#1c1108;font-weight:700}
        .w{width:100%;margin-top:6px}
        small{color:#ab9d8c;display:block;line-height:1.4;margin-top:6px}
      </style>
      <div class="p">
        <div class="h"><span>● Запись</span><span>шагов: <b id="c">0</b>
          <button id="mv" title="Перенести панель на другую сторону, если она закрывает кнопки сайта" style="padding:2px 7px;margin-left:6px">⇆</button>
          <button id="mn" title="Свернуть панель" style="padding:2px 7px">—</button></span></div>
        <div id="body">
        <small>Делайте всё как обычно. Чтобы вставить текст товара — кликните в поле сайта (курсор должен мигать в нём), потом кнопку:</small>
        <div class="g">
          <button data-v="title">Название</button><button data-v="body">Описание</button>
          <button data-v="price">Цена</button><button data-v="size">Размер</button>
          <button data-v="code">Код</button><button id="wait">Пауза 3 сек</button>
        </div>
        <small>Фото: просто нажмите кнопку загрузки фото на сайте — программа подставит их сама.</small>
        <button id="pub" class="w">Следующий клик = «Опубликовать»</button>
        <button id="undo" class="w">↶ Отменить последний шаг</button>
        <button id="done" class="w a">Готово — сохранить сценарий</button>
        </div>
      </div>`;
    root.getElementById("mv").addEventListener("click", () => {
      const left = host.style.left === "16px";
      host.style.left = left ? "" : "16px";
      host.style.right = left ? "16px" : "";
    });
    root.getElementById("mn").addEventListener("click", () => {
      const b = root.getElementById("body");
      b.style.display = b.style.display === "none" ? "" : "none";
    });
    countEl = root.getElementById("c");
    publishBtn = root.getElementById("pub");
    // mousedown без фокуса: курсор остаётся в поле сайта, куда нужно вставить текст
    root.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
    root.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => fillVar(b.dataset.v)));
    root.getElementById("wait").addEventListener("click", () => send({ action: "wait", ms: 3000, label: "пауза" }));
    publishBtn.addEventListener("click", () => { publishNext = !publishNext; updatePublishBtn(); });
    root.getElementById("undo").addEventListener("click", () => window.__dpUndo().then(setCount));
    root.getElementById("done").addEventListener("click", () => window.__dpDone());
    document.body.appendChild(host);
    window.__dpCount && window.__dpCount().then(setCount);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildPanel);
  else buildPanel();
  setInterval(buildPanel, 1500); // если сайт перерисовал страницу
})();
