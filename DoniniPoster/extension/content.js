// Donini Poster — работает на страницах сайтов в ВАШЕМ браузере.
// Режимы: «выставление» (заполняет форму по сценарию) и «запись» (запоминает ваши действия).
(() => {
  if (window.__doniniLoaded) return;
  window.__doniniLoaded = true;

  const IS_TOP = window === window.top;
  const PANEL_ID = "__donini_panel";
  const PUBLISH_RE = /zveřejn|opublikuj|veröffentlich|anzeige aufgeben|plaats (je )?advertentie|plaatsen|predaj oglas|objavi oglas|подать объявление|опубликовать|feladás|hirdetés feladása|publicar|publică|publish|dodaj ogłoszenie/i;
  const bg = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  let unloading = false;
  addEventListener("pagehide", () => { unloading = true; });

  // ================= общие помощники =================
  const cleanText = (t) => (t || "").replace(/\s+/g, " ").trim();
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const looksGenerated = (s) => !s || s.length > 40 || /\d{4,}/.test(s) || /^[a-f0-9-]{16,}$/i.test(s) || /:r\d|^ember\d|^react/i.test(s);
  const isPanel = (el) => { let n = el; while (n) { if (n.id === PANEL_ID) return true; n = n.parentNode || n.host; } return false; };
  const deep = (ev) => (ev.composedPath && ev.composedPath()[0]) || ev.target;
  const isTextField = (el) => {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !["checkbox", "radio", "file", "submit", "button", "hidden", "image", "reset", "range", "color"].includes((el.type || "text").toLowerCase());
    return false;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };

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
    } else if (txt && !isTextField(el) && tag !== "select") {
      // длинный текст (пункт списка с пояснением) — ищем по первой строке
      const first = cleanText((el.innerText || "").split("\n")[0]);
      if (first && first.length <= 50) out.push(`${tag}:has-text("${first.replace(/"/g, '\\"')}")`);
    }
    out.push(cssPath(el));
    return Array.from(new Set(out));
  }
  const isCheck = (el) => el && el.tagName === "INPUT" && ["checkbox", "radio"].includes((el.type || "").toLowerCase());
  function checkInputOf(el) {
    if (!el) return null;
    if (isCheck(el)) return el;
    const lab = el.closest && el.closest("label");
    if (lab) {
      if (isCheck(lab.control)) return lab.control;
      const inner = lab.querySelector('input[type="checkbox"], input[type="radio"]');
      if (inner) return inner;
    }
    return null;
  }
  const clickable = (el) => el.closest("button, a, label, [role=button], [role=option], [role=menuitem], [role=tab], [role=radio], [role=checkbox], li, input") || el;

  // querySelectorAll, который видит и элементы внутри shadow DOM (веб-компоненты)
  function qsaDeep(sel, root = document) {
    let out = [];
    try { out = Array.from(root.querySelectorAll(sel)); } catch (e) { return []; }
    const walk = (node) => {
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot && !isPanel(el)) {
          try { out.push(...el.shadowRoot.querySelectorAll(sel)); } catch (e) {}
          walk(el.shadowRoot);
        }
      }
    };
    walk(root);
    return out;
  }
  const isConnectedEl = (el) => !!(el && el.isConnected);
  // элемент с фокусом, даже если он внутри shadow DOM или в редакторе-фрейме
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (a && a.tagName === "IFRAME") {
      try {
        const d = a.contentDocument;
        if (d && (d.designMode === "on" || (d.body && d.body.isContentEditable))) return d.body;
        if (d && d.activeElement && isTextField(d.activeElement)) return d.activeElement;
      } catch (e) {}
    }
    return a;
  }

  // поиск элемента по сохранённым селекторам (понимает и формат программы: tag:has-text("…"), text="…")
  function resolveOne(sel) {
    let m = sel.match(/^([a-z0-9-]+):has-text\("(.*)"\)$/i);
    if (m) {
      const want = m[2].replace(/\\"/g, '"');
      const all = qsaDeep(m[1]).filter((e) => cleanText(e.innerText || e.textContent).includes(want));
      // берём самые «глубокие» совпадения (сам пункт), а не весь список, который тоже содержит этот текст;
      // точное совпадение текста — в приоритете (чтобы «Novo com etiqueta» не путался с похожими)
      const deepest = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
      const exact = deepest.filter((e) => cleanText((e.innerText || e.textContent).split("\n")[0]) === want || cleanText(e.innerText || e.textContent) === want);
      return exact.length ? exact.concat(deepest.filter((e) => !exact.includes(e))) : deepest;
    }
    m = sel.match(/^text="(.*)"$/);
    if (m) {
      const want = m[1].replace(/\\"/g, '"');
      const all = qsaDeep("body *, *").filter((e) => cleanText(e.innerText) === want);
      return all.filter((e) => !all.some((o) => o !== e && e.contains(o))); // самые «глубокие»
    }
    return qsaDeep(sel);
  }
  async function locate(step, timeout = 20000) {
    const sels = step.selectors || [];
    const end = Date.now() + timeout;
    while (Date.now() < end && !unloading) {
      // если селектор подходит сразу к нескольким полям (например, у всех списков placeholder «Selecionar»),
      // не берём первое попавшееся — сначала пробуем остальные, более точные селекторы
      let ambiguous = null, hidden = null;
      if (step.action === "upload") {
        // для фото в первую очередь — само поле выбора файлов, а не кнопка рядом
        for (const sel of sels) {
          const fi = resolveOne(sel).filter((e) => e.matches && e.matches('input[type="file"]') && !isPanel(e));
          if (fi.length) return fi[0];
        }
      }
      for (const sel of sels) {
        const found = resolveOne(sel).filter((e) => !isPanel(e));
        const vis = found.filter(visible);
        const textSel = /:has-text\(|^text="/.test(sel);
        if (vis.length > 1 && textSel) {
          // одинаковые кнопки («NASTAVI» на Njuškalo): одна спрятана (1×1 px, для экранных дикторов) — берём настоящую
          const big = vis.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
          if (big.length) return big[0];
        }
        if (vis.length === 1 || (vis.length && textSel)) return vis[0];
        if (vis.length > 1) { if (!ambiguous) ambiguous = vis[0]; continue; }
        if (found.length && !hidden && (step.action === "upload" || step.action === "fill")) hidden = found[0];
        // переключатели-«рычажки» (Publi24 «Da/Nu», 2dehands «Bieden toestaan»): сама галочка спрятана, видна только подпись
        if (found.length && !hidden && step.action === "check" && found[0].matches && found[0].matches('input[type="checkbox"], input[type="radio"]')) hidden = found[0];
      }
      if (ambiguous) return ambiguous;
      if (hidden) return hidden;
      await sleep(400);
    }
    return null;
  }

  // Когда окно Chrome не в фокусе (вы в другой программе / другой вкладке), el.focus() не присылает сайту
  // событие «поле получило фокус». Некоторые сайты (Marktplaats) без него не запоминают введённый текст — шлём сами.
  function fieldEntered(el) {
    if (!el || !el.dispatchEvent) return;
    const doc = el.ownerDocument || document;
    if (doc.hasFocus && doc.hasFocus() && doc.activeElement === el) return; // фокус настоящий — сайт уже знает
    try {
      el.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    } catch (e) {}
  }

  // Редакторы с «умной» моделью текста (Lexical на Marktplaats, ProseMirror, Draft.js): обычная вставка
  // меняет только экран, а сам сайт текста «не видит», пока не нажмёшь клавишу — и не даёт опубликовать.
  // Вставляем как «Ctrl+V»: редактор сам принимает текст (с переносами строк) и обновляет форму.
  const normTxt = (t) => String(t || "").replace(/\s+/g, "");
  async function pasteRich(el, value) {
    if (!el.isContentEditable && !(el.querySelector && el.querySelector('[contenteditable="true"], [contenteditable=""]'))) return false;
    if (!el.isContentEditable) el = el.querySelector('[contenteditable="true"], [contenteditable=""]');
    const doc = el.ownerDocument || document;
    if (doc.designMode === "on") return false;
    el.focus();
    fieldEntered(el);
    await sleep(150);
    const sel = doc.getSelection(), range = doc.createRange();
    range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
    await sleep(150); // редактор подхватывает выделение не сразу
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    await sleep(500);
    if (!ev.defaultPrevented) return false; // редактор вставку не обработал — пусть работает обычный способ
    const got = normTxt(el.innerText), want = normTxt(value);
    if (got === want) return true;
    // вставилось не поверх, а рядом со старым текстом — очищаем и пробуем ещё раз
    range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
    await sleep(150);
    try { doc.execCommand("delete"); } catch (e) {}
    await sleep(150);
    const dt2 = new DataTransfer(); dt2.setData("text/plain", value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt2, bubbles: true, cancelable: true }));
    await sleep(500);
    return normTxt(el.innerText) === want;
  }

  function insertText(el, value) {
    if (!isTextField(el) && !(el.ownerDocument && el.ownerDocument.designMode === "on")) {
      // нашли «обёртку» поля — ищем само поле внутри
      const inner = el.querySelector && el.querySelector('textarea, [contenteditable="true"], [contenteditable=""], input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])');
      if (!inner) throw new Error("найденный элемент — не поле для текста");
      el = inner;
    }
    el.focus();
    fieldEntered(el);
    const doc = el.ownerDocument || document;
    if (el.isContentEditable || doc.designMode === "on") {
      const sel = doc.getSelection(), range = doc.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      let ok = false;
      try { ok = doc.execCommand("insertText", false, value); } catch (e) {}
      if (!ok) { el.innerText = value; el.dispatchEvent(new InputEvent("input", { bubbles: true })); }
      return true;
    }
    try { el.select(); } catch (e) {}
    let ok = false;
    try { ok = document.execCommand("insertText", false, value); } catch (e) {}
    if (!ok || el.value !== value) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  // прокрутка только внутри своего списка: прокрутка всей страницы закрывает многие выпадающие меню
  const scrollBoxOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  };
  function bringIntoView(el) {
    const box = scrollBoxOf(el);
    if (box) {
      const br = box.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.top < br.top || r.bottom > br.bottom) box.scrollTop += r.top - br.top - (box.clientHeight - r.height) / 2;
    }
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: "center", inline: "nearest" });
  }
  // пункт длинного списка ещё не показан (списки подгружают пункты при прокрутке) — листаем список и ищем
  async function scrollSearch(step) {
    const boxes = qsaDeep("*").filter((e) => !isPanel(e) && e !== document.body && e !== document.documentElement && visible(e) &&
      e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    boxes.sort((a, b) => (b.matches('[role="listbox"], ul, [class*="list" i], [class*="menu" i], [class*="option" i]') ? 1 : 0) -
                         (a.matches('[role="listbox"], ul, [class*="list" i], [class*="menu" i], [class*="option" i]') ? 1 : 0));
    for (const box of boxes.slice(0, 6)) {
      const start = box.scrollTop;
      box.scrollTop = 0; await sleep(150);
      for (let k = 0; k < 80; k++) {
        const el = await locate(step, 250);
        if (el && box.contains(el)) return el;
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) break;
        box.scrollTop += Math.max(40, box.clientHeight * 0.7);
        await sleep(200);
      }
      box.scrollTop = start;
    }
    return null;
  }
  // Кнопка отправки формы, которой управляет сам сайт (vatera.hu): при программном клике браузер
  // дополнительно отправляет форму «по-старому» (GET на ту же страницу) — страница перезагружается и всё теряется.
  // Такую отправку отменяем: обработчик сайта всё равно срабатывает и сам ведёт на следующий шаг.
  function guardNativeSubmit(el) {
    const btn = el.closest && el.closest('button, input[type="submit"], input[type="image"]');
    const form = btn && btn.form;
    if (!form) return;
    const type = (btn.getAttribute("type") || "submit").toLowerCase();
    if (btn.tagName === "BUTTON" && type !== "submit") return;
    const action = (form.getAttribute("action") || "").trim();
    const method = (form.getAttribute("method") || "get").toLowerCase();
    if (method !== "get" || (action && action !== "#" && new URL(action, location.href).pathname !== location.pathname)) return;
    // у самой кнопки может быть свой адрес/метод отправки (formaction / formmethod) — тогда это настоящая отправка
    const bMethod = (btn.getAttribute("formmethod") || "").toLowerCase();
    const bAction = (btn.getAttribute("formaction") || "").trim();
    if ((bMethod && bMethod !== "get") || (bAction && bAction !== "#" && new URL(bAction, location.href).pathname !== location.pathname)) return;
    const root = form.getRootNode();
    const stop = (e) => { if (e.target === form) e.preventDefault(); };
    root.addEventListener("submit", stop, false);
    setTimeout(() => root.removeEventListener("submit", stop, false), 3000);
    // Страховка: если сайт ждал именно обычную отправку формы (кнопка застыла на «Folyamatban…» /
    // стала неактивной, а страница никуда не перешла) — через 5 сек отправляем форму сами.
    const startUrl = location.href;
    setTimeout(() => {
      if (unloading || location.href !== startUrl || !btn.isConnected || !form.isConnected) return;
      const t = cleanText(btn.innerText || btn.value || "");
      const stuck = btn.disabled || /folyamat|feldolgoz|kérjük|loading|wait|zpracov|čekej|przetwarz|proszę|bezig|cargando|procesando|в процессе|подожд/i.test(t);
      if (!stuck) return;
      try {
        if (btn.name) {
          const h = document.createElement("input");
          h.type = "hidden"; h.name = btn.name; h.value = btn.value || "";
          form.appendChild(h);
        }
        HTMLFormElement.prototype.submit.call(form);
      } catch (e) {}
    }, 5000);
  }
  function clickEl(el) {
    guardNativeSubmit(el);
    bringIntoView(el);
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const t of ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o));
    // списки-«комбобоксы» (OLX: «Płeć — Wybierz») открываются по событию «поле получило фокус».
    // Когда окно браузера не в фокусе (работа в фоне), браузер этого события не шлёт — шлём сами.
    const textLike = el.matches && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), [role="combobox"], textarea');
    if (textLike && el === deepActive()) { try { el.blur(); } catch (e) {} }
    if (el.focus) el.focus();
    if (textLike) fieldEntered(el);
    for (const t of ["pointerup", "mouseup"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o));
    el.click();
  }
  function setSelect(el, value, label) {
    const opt = Array.from(el.options).find((o) => o.value === value) || Array.from(el.options).find((o) => cleanText(o.text) === label);
    if (opt) el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function toFiles(list) {
    return list.map((p) => {
      const bin = atob(p.b64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], p.name, { type: p.type });
    });
  }
  function putFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function findFileInput(near) {
    const all = qsaDeep('input[type="file"]');
    if (!all.length) return null;
    const img = (i) => !i.accept || /image|\.jp|\.png/i.test(i.accept);
    let box = near;
    for (let k = 0; k < 6 && box; k++, box = box.parentElement) {
      const inside = all.find((i) => box.contains(i) && img(i));
      if (inside) return inside;
    }
    return all.find(img) || all[0];
  }
  async function uploadFiles(el, files) {
    let input = el && el.matches && el.matches('input[type="file"]') ? el : findFileInput(el || document.body);
    if (!input && el) { clickEl(el); await sleep(1000); input = findFileInput(el); }
    if (!input) {
      // запасной вариант: «бросаем» файлы на область загрузки
      const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
      for (const t of ["dragenter", "dragover", "drop"]) (el || document.body).dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      return files.length;
    }
    if (input.multiple || files.length === 1) { putFiles(input, files); }
    else {
      putFiles(input, [files[0]]);
      for (const f of files.slice(1)) { await sleep(1800); putFiles(findFileInput(el || document.body) || input, [f]); }
    }
    return files.length;
  }
  // ===== выбор пункта в выпадающем списке по НАЗВАНИЮ поля («Marca» → «Outras Marcas») =====
  const normLabel = (s) => cleanText(s).replace(/[*:]/g, "").trim().toLowerCase();
  // порядок важен: сначала само поле списка, а не обёртка вокруг него (на OLX.pt обёртка тоже «кликабельная»)
  const CONTROL_PRI = ['select', 'input[role="combobox"]', '[role="combobox"]',
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])', '[aria-haspopup]', 'button'];
  const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  function findFieldByLabel(label) {
    const want = normLabel(label);
    const all = qsaDeep("label, legend, span, p, div, h2, h3, h4, h5, dt, strong")
      .filter((e) => !isPanel(e) && visible(e) && normLabel(e.innerText || e.textContent) === want);
    const labs = all.filter((e) => !all.some((o) => o !== e && e.contains(o))); // самые «глубокие»
    for (const lab of labs) {
      const lb = lab.closest("label");
      if (lb && lb.control && !isCheck(lb.control)) return { control: lb.control, box: lb.parentElement || lb };
      let box = lab.parentElement;
      for (let k = 0; k < 5 && box && box !== document.body; k++, box = box.parentElement) {
        for (const sel of CONTROL_PRI) {
          const ctl = Array.from(box.querySelectorAll(sel))
            .find((c) => !isPanel(c) && visible(c) && !lab.contains(c) && after(lab, c));
          if (ctl) return { control: ctl, box };
        }
      }
    }
    return null;
  }
  const fieldShows = (f, option) => {
    const want = normLabel(option);
    const v = f.control.tagName === "SELECT" ? (f.control.selectedOptions[0] || {}).text : (f.control.value ?? f.control.innerText);
    return normLabel(v) === want || normLabel(f.control.innerText || "") === want;
  };
  function findOption(option, f) {
    const want = cleanText(option);
    const all = qsaDeep("body *").filter((e) => !isPanel(e) && cleanText(e.innerText) === want && visible(e));
    const deepest = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
    if (!f) return deepest[0] || null;
    // сначала пункты открытого списка вне поля, потом — внутри блока поля (но не текст, что уже стоит в самом поле)
    return deepest.find((e) => !f.box.contains(e)) ||
      deepest.find((e) => e.closest('[role="option"], [role="listbox"], li, ul') && !f.control.contains(e)) || null;
  }
  async function pickInList(st) {
    const field = st.field, option = st.option;
    let f = null;
    const end = Date.now() + 20000;
    while (!f && Date.now() < end && !unloading) { f = findFieldByLabel(field); if (!f) await sleep(500); }
    if (!f) throw new Error(`не найдено поле «${field}»`);
    if (fieldShows(f, option)) return true; // уже выбрано
    if (f.control.tagName === "SELECT") {
      setSelect(f.control, null, cleanText(option));
      if (fieldShows(f, option)) return true;
    }
    for (let attempt = 0; attempt < 3 && !unloading; attempt++) {
      bringIntoView(f.control);
      // если курсор уже стоит в этом поле, повторный клик список не открывает — сначала убираем фокус
      if (f.control === deepActive()) { try { f.control.blur(); } catch (e) {} await sleep(300); }
      clickEl(f.control);
      await sleep(900);
      let opt = null;
      const t = Date.now() + 3000;
      while (!opt && Date.now() < t) { opt = findOption(option, f); if (!opt) await sleep(300); }
      if (!opt) opt = await scrollSearch({ action: "click", selectors: [`text="${cleanText(option).replace(/"/g, '\\"')}"`] });
      if (!opt && isTextField(f.control) && !f.control.readOnly) {
        insertText(f.control, option); // список с поиском — печатаем название пункта
        await sleep(1000);
        opt = findOption(option, f);
      }
      if (opt) {
        clickEl(opt);
        await sleep(900);
        f = findFieldByLabel(field) || f;
        if (fieldShows(f, option) || normLabel(f.box.innerText).includes(normLabel(option))) return true;
      }
      document.body.click(); // закрыть список и попробовать ещё раз
      await sleep(600);
      f = findFieldByLabel(field) || f;
    }
    throw new Error(`не удалось выбрать «${option}» в поле «${field}»`);
  }

  // «Курсор ушёл из поля». Во вкладке, которая сейчас не на экране, браузер этих событий сам не шлёт,
  // а сайты на них проверяют поле и подгружают подсказки (vatera.hu: категории по названию) — шлём сами.
  function fieldLeft(el) {
    if (!el || !el.dispatchEvent) return;
    try {
      el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    } catch (e) {}
  }

  // переключатели с именем st.name: берём первый, чья подпись подходит под st.prefer (по порядку), иначе первый в списке
  // (на vatera.hu категории предлагаются по названию товара — появляются через пару секунд после ввода названия)
  async function chooseRadio(st) {
    const labelOf = (r) => cleanText((r.labels && r.labels[0] ? r.labels[0].innerText : (r.closest("label") || r.parentElement || {}).innerText) || "");
    let radios = [];
    const end = Date.now() + (st.timeout || 15000);
    let nudged = 0;
    while (!radios.length && Date.now() < end && !unloading) {
      if (st.name) radios = qsaDeep(`input[type="radio"][name="${st.name}"]`).filter((r) => !isPanel(r) && !r.disabled);
      else if (st.group) {
        // поле по его подписи (Vatera: «Kinek *» → férfi / gyerek / női …): ищем подпись и переключатели под ней
        const want = normLabel(st.group);
        const heads = qsaDeep("label, legend, span, p, div, h3, h4, strong, dt").filter((e) => !isPanel(e) && visible(e) &&
          normLabel((e.innerText || "").split("\n")[0]) === want && !e.querySelector('input[type="radio"]'));
        for (const h of heads) {
          let box = h.parentElement;
          for (let k = 0; k < 4 && box && !radios.length; k++, box = box.parentElement) {
            const rs = Array.from(box.querySelectorAll('input[type="radio"]')).filter((r) => !isPanel(r) && !r.disabled);
            if (rs.length) radios = rs.filter((r) => r.name === rs[0].name);
          }
          if (radios.length) break;
        }
      }
      if (!radios.length) {
        // варианты подгружаются, когда курсор уходит из заполненных полей — «уводим» его ещё раз
        if (nudged++ % 6 === 0) {
          for (const f of qsaDeep('input[type="text"], input:not([type]), textarea')) if (!isPanel(f) && f.value) fieldLeft(f);
        }
        await sleep(500);
      }
    }
    if (!radios.length) { if (st.ifPresent) return true; throw new Error(`нет вариантов для «${st.label || st.name || st.group}»`); }
    let target = null;
    for (const p of st.prefer || []) {
      const low = String(p).toLowerCase();
      target = radios.find((r) => st.exact ? labelOf(r).toLowerCase() === low : labelOf(r).toLowerCase().includes(low));
      if (target) break;
    }
    if (!target && st.exact) throw new Error(`нет варианта «${(st.prefer || []).join(" / ")}» в «${st.label || st.name}»`);
    target = target || radios[0];
    if (target.checked) return true;
    const lab = target.labels && target.labels[0];
    clickEl(lab && visible(lab) ? lab : target);
    await sleep(500);
    if (!target.checked) { clickEl(target); await sleep(500); }
    if (!target.checked) throw new Error(`не удалось выбрать «${labelOf(target)}»`);
    return true;
  }

  // Пункт многоуровневого списка категорий по «адресу» из записи: li:nth-of-type(17) > … > li:nth-of-type(8)
  // = 4-й уровень, 8-й пункт. Уровни — это отдельные списки (ul) с переключателями одного имени, слева направо.
  async function pickByLevel(st, timeout) {
    const m = ((st.selectors || [])[0] || "").match(/name="([^"]+)"/);
    const name = m ? m[1].replace(/\\/g, "") : null;
    const path = (st.alt || []).filter((s) => /li:nth-of-type\(\d+\)/.test(s)).pop();
    if (!name || !path) return null;
    const idx = Array.from(path.matchAll(/li:nth-of-type\((\d+)\)/g)).map((x) => Number(x[1]));
    const level = idx.length, n = idx[idx.length - 1];
    const end = Date.now() + timeout;
    while (Date.now() < end && !unloading) {
      const lists = [];
      for (const r of qsaDeep(`input[name="${name}"]`)) {
        const ul = r.closest("ul");
        if (ul && visible(ul) && !lists.includes(ul)) lists.push(ul);
      }
      const ul = lists[level - 1];
      if (ul) {
        const li = Array.from(ul.children).filter((x) => x.tagName === "LI")[n - 1];
        const lab = li && (li.querySelector("label") || li);
        if (lab && visible(lab)) return lab;
      }
      await sleep(400);
    }
    return null;
  }

  // элемент виден и не закрыт сверху окном/затемнением
  function uncovered(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    if (r.bottom < 0 || r.top > innerHeight) return true; // вне экрана — проверить нельзя, считаем открытым
    let top = document.elementFromPoint(x, y);
    while (top && top.shadowRoot) { const t2 = top.shadowRoot.elementFromPoint(x, y); if (!t2 || t2 === top) break; top = t2; }
    return !!top && (el === top || el.contains(top) || top.contains(el) || (el.labels && Array.from(el.labels).some((l) => l.contains(top))));
  }

  // ===== записанная пара: клик по полю-списку, затем клик по пункту =====
  const isListControl = (e) => !!e && (e.tagName === "SELECT" || e.getAttribute("role") === "combobox" || e.hasAttribute("aria-haspopup") ||
    (e.tagName === "INPUT" && isTextField(e)));
  function looksLikeListOpener(st) {
    return (st.selectors || []).some((s) => /^(input|select)\b|combobox|aria-haspopup|placeholder=/i.test(s));
  }
  // пункт уже показан как значение поля (не в открытом списке)
  function optionAlreadyShown(option) {
    const want = normLabel(option);
    if (!want) return false;
    const inList = (e) => !!e.closest('[role="option"], [role="listbox"], [role="menu"], [role="menuitem"], li, a');
    if (qsaDeep('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])')
      .some((e) => !isPanel(e) && visible(e) && normLabel(e.value) === want)) return true;
    const all = qsaDeep("body *").filter((e) => !isPanel(e) && visible(e) && normLabel(e.innerText || "") === want && !inList(e));
    return all.length > 0;
  }
  function optionTextOf(st) {
    for (const s of st.selectors || []) { const m = s.match(/^text="(.*)"$/); if (m) return cleanText(m[1].replace(/\\"/g, '"')); }
    for (const s of st.selectors || []) { const m = s.match(/:has-text\("(.*)"\)$/); if (m) return cleanText(m[1].replace(/\\"/g, '"')); }
    return cleanText(st.label || "");
  }
  const controlValue = (c) => c.tagName === "SELECT" ? ((c.selectedOptions[0] || {}).text || "") : (c.value ?? c.innerText ?? "");
  // все поля-списки на странице (по порядку) — чтобы после выбора проверить, что значение действительно встало,
  // даже если сайт пересоздал поле (так делает OLX.pt)
  const listControls = () => qsaDeep('select, input[role="combobox"], [role="combobox"] input, input[type="text"], input:not([type])')
    .filter((e) => !isPanel(e) && visible(e));
  const textNodesOf = (option) => {
    const want = cleanText(option);
    const all = qsaDeep("body *").filter((e) => !isPanel(e) && visible(e) && cleanText(e.innerText) === want);
    return all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
  };
  async function tryListControl(c, option, waitMs = 5000) {
    if (!c || !c.isConnected || !isListControl(c)) return false;
    const want = normLabel(option);
    if (normLabel(controlValue(c)) === want) return true; // уже стоит нужное
    if (c.tagName === "SELECT") {
      setSelect(c, null, option);
      return normLabel(controlValue(c)) === want;
    }
    const idx = listControls().indexOf(c);
    const before = new Set(textNodesOf(option)); // такой же текст, который был виден ДО открытия списка (например, название категории)
    bringIntoView(c);
    if (c === deepActive()) { try { c.blur(); } catch (e) {} await sleep(300); }
    clickEl(c);
    let opt = null;
    const t = Date.now() + waitMs; // длинные списки (марки) сайт подгружает не сразу
    while (!opt && Date.now() < t && !unloading) {
      await sleep(300);
      const fresh = textNodesOf(option).filter((e) => !before.has(e) && !c.contains(e));
      opt = fresh.find((e) => e.closest('[role="option"], [role="listbox"], [role="menu"], li, ul')) || fresh[0] || null;
    }
    if (opt) {
      clickEl(opt);
      for (let k = 0; k < 6; k++) {
        await sleep(300);
        const now = c.isConnected ? c : listControls()[idx];
        if (now && normLabel(controlValue(now)) === want) return true;
        if (now && normLabel((now.parentElement || now).innerText).includes(want) && !normLabel(controlValue(now))) return true;
      }
    }
    // не тот список — закрываем
    const cc = c.isConnected ? c : listControls()[idx];
    if (cc) { cc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); try { cc.blur(); } catch (e) {} }
    await sleep(400);
    return false;
  }
  async function pickPair(st, option) {
    const hint = await locate(st, 15000);
    if (!hint) return false;
    // сначала поле, что нашлось по сохранённым селекторам
    if (await tryListControl(hint, option)) return true;
    // не то поле (у всех списков одинаковая подсказка) — пробуем остальные списки на странице, сверху вниз
    const cands = [];
    for (const sel of st.selectors || []) for (const e of resolveOne(sel)) if (!isPanel(e) && visible(e) && isListControl(e) && !cands.includes(e)) cands.push(e);
    for (const e of qsaDeep('input[role="combobox"], [role="combobox"] input, select')) if (!isPanel(e) && visible(e) && !cands.includes(e)) cands.push(e);
    for (const c of cands) {
      if (c === hint || unloading) continue;
      if (normLabel(controlValue(c)) && normLabel(controlValue(c)) !== normLabel(option) && c.getAttribute("role") === "combobox" && cands.some((o) => o !== c && !normLabel(controlValue(o)))) {
        // список уже заполнен другим значением, а есть пустые — его оставляем на потом
        continue;
      }
      if (await tryListControl(c, option)) return true;
    }
    for (const c of [hint, ...cands]) { // второй круг: все списки ещё раз, ждём дольше
      if (unloading || !c.isConnected) continue;
      if (await tryListControl(c, option, 8000)) return true;
    }
    return false;
  }

  // ждём, пока сайт загрузит все фото на сервер: пока фото грузится, его превью — временный blob:-адрес
  // (на vatera.hu каждое фото грузится несколько секунд; без ожидания следующие шаги ломают форму)
  async function waitUploadsDone(n, i) {
    const pending = () => qsaDeep("img").filter((im) => !isPanel(im) && visible(im) &&
      /^blob:/.test(im.currentSrc || im.src || "")).length;
    const progress = () => qsaDeep('progress, [role="progressbar"]').filter((e) => !isPanel(e) && visible(e)).length;
    const start = Date.now();
    let last = -1, changed = Date.now(), calm = 0;
    while (Date.now() - start < 300000 && !unloading) {
      const p = pending() + progress();
      if (p !== last) { last = p; changed = Date.now(); }
      if (p === 0) { if (++calm >= 3) break; } else calm = 0; // 3 проверки подряд без загрузок
      if (p > 0 && Date.now() - changed > 90000) break; // 1.5 минуты без изменений — дальше не ждём
      status(`Шаг ${i + 1}: жду загрузку фото${p ? ` (осталось ${p})` : ""}…`);
      await sleep(700);
    }
    await sleep(800);
  }

  // описание в редакторе TinyMCE / CKEditor — через его собственные команды (обычная вставка такие редакторы часто не видят)
  const hasRichEditor = () => qsaDeep('.tox-tinymce, .mce-tinymce, .mce-container, .cke, .ck-editor, textarea.tinymce, iframe[id$="_ifr"]').length > 0;
  async function fillRichEditor(value) {
    const r = await bg({ type: "setRichEditor", value });
    if (r && r.ok) return true;
    // запасной путь: пишем прямо в тело редактора-фрейма и в спрятанное поле формы
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = String(value).split(/\n{2,}/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
    for (const f of qsaDeep('iframe[id$="_ifr"], .tox-edit-area iframe, .mce-edit-area iframe, iframe.cke_wysiwyg_frame')) {
      let d = null; try { d = f.contentDocument; } catch (e) {}
      if (!d || !d.body) continue;
      d.body.innerHTML = html;
      d.body.dispatchEvent(new InputEvent("input", { bubbles: true }));
      d.body.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      const ta = f.id && document.getElementById(f.id.replace(/_ifr$/, ""));
      if (ta && "value" in ta) {
        ta.value = html;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (cleanText(d.body.innerText)) return true;
    }
    return false;
  }

  const render = (v, ad) => String(v || "").replace(/\{(title|body|price|size|code|currency|brand)\}/g, (_, k) => String(ad[k] ?? ""));

  // элемент внутри документа фрейма (той же страницы)
  function findIn(doc, step) {
    for (const sel of step.selectors || []) {
      let found = [];
      try { found = Array.from(doc.querySelectorAll(sel)); } catch (e) {}
      if (found.length) return found[0];
    }
    return null;
  }
  const editableIn = (el) => el && (isTextField(el) || el.isContentEditable || (el.ownerDocument && el.ownerDocument.designMode === "on"));
  // редакторы описания (TinyMCE, CKEditor…) живут во фрейме той же страницы — находим его сами
  async function stepInSameOriginFrame(step, value) {
    const end = Date.now() + 6000;
    while (Date.now() < end && !unloading) {
      let cands = [];
      if (step.frameSel) {
        for (const sel of step.frameSel) { cands = resolveOne(sel).filter((e) => e.tagName === "IFRAME"); if (cands.length) break; }
      }
      if (!cands.length) {
        cands = qsaDeep("iframe").filter((f) => visible(f));
        cands.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
      }
      for (const f of cands) {
        let doc = null;
        try { doc = f.contentDocument; } catch (e) {}
        if (!doc || !doc.body) continue;
        const el = findIn(doc, step);
        if (!el) continue;
        if (step.action === "fill") {
          if (!editableIn(el) && !step.frameSel) continue; // не тот фрейм (реклама, капча)
          try { f.contentWindow.focus(); } catch (e) {}
          insertText(el, value);
        } else if (step.action === "select") setSelect(el, step.value, step.label);
        else clickEl(el);
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  // самое большое поле для длинного текста в документе (textarea / редактор / редактор-фрейм той же страницы)
  function biggestEditable(doc = document) {
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    const c = [];
    for (const e of qsaDeep('textarea, [contenteditable="true"], [contenteditable=""]', doc)) {
      if (isPanel(e) || !visible(e) || e.disabled || e.readOnly) continue;
      if (e.isContentEditable && e.parentElement && e.parentElement.isContentEditable) continue; // только корень редактора
      c.push({ el: e, a: area(e) });
    }
    if (doc.body && (doc.designMode === "on" || doc.body.isContentEditable)) c.push({ el: doc.body, a: 1e6 });
    for (const f of qsaDeep("iframe", doc)) {
      if (!visible(f)) continue;
      let d = null; try { d = f.contentDocument; } catch (e) {}
      if (d && d.body && (d.designMode === "on" || d.body.isContentEditable)) c.push({ el: d.body, a: area(f), frame: f });
    }
    c.sort((x, y) => y.a - x.a);
    return c.find((x) => x.a > 3000) || null;
  }
  async function fillDescriptionAnywhere(value) {
    const end = Date.now() + 12000;
    while (Date.now() < end && !unloading) {
      const t = biggestEditable();
      if (t) { if (t.frame) try { t.frame.contentWindow.focus(); } catch (e) {} insertText(t.el, value); return true; }
      // редактор во фрейме с другого адреса — спрашиваем фреймы через фон
      const r = await bg({ type: "fillBiggestAnyFrame", value });
      if (r && r.ok) return true;
      await sleep(800);
    }
    return false;
  }

  // шаг внутри фрейма (вызывает верхняя страница через фон)
  async function doStepHere(step, value) {
    const el = await locate(step, 6000);
    if (!el) return { ok: false, error: "не найден элемент во фрейме" };
    if (step.action === "fill") insertText(el, value);
    else if (step.action === "select") setSelect(el, step.value, step.label);
    else clickEl(el);
    return { ok: true };
  }

  // последнее поле, где стоял курсор (для ручных кнопок и записи)
  let lastField = null;
  document.addEventListener("focusin", (ev) => {
    const el = deep(ev);
    if (!isPanel(el) && isTextField(el)) {
      lastField = el;
      if (recording) bg({ type: "recFocus", selectors: selectorsFor(el) });
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === "publishCheck") {
      if (window !== window.top) return; // отвечает только сама страница
      reply({ errors: visibleFormErrors().slice(0, 3) });
      return;
    }
    if (msg.type === "focusInfo") {
      // в каком фрейме сейчас реально стоит курсор (если он во вложенном фрейме — ответит сам фрейм)
      if (document.activeElement && document.activeElement.tagName === "IFRAME") { reply({ focused: false }); return; }
      const act = deepActive();
      const field = !!act && (isTextField(act) || (act.ownerDocument && act.ownerDocument.designMode === "on"));
      let frameSel = null;
      try { if (window.frameElement) frameSel = selectorsFor(window.frameElement); } catch (e) {}
      reply({ focused: document.hasFocus(), field, selectors: field ? selectorsFor(act) : null, frameSel });
      return;
    }
    if (msg.type === "insertFocused") {
      const act = document.hasFocus() ? deepActive() : null;
      const el = (act && (isTextField(act) || (act.ownerDocument && act.ownerDocument.designMode === "on"))) ? act : lastField;
      if (!el || !isConnectedEl(el)) { reply({ ok: false }); return; }
      reply({ ok: insertText(el, msg.value) });
    } else if (msg.type === "fillBiggest") {
      const t = !IS_TOP ? biggestEditable() : null;
      if (!t) { reply({ ok: false }); return; }
      try { insertText(t.el, msg.value); reply({ ok: true }); } catch (e) { reply({ ok: false }); }
    } else if (msg.type === "doFrameStep") {
      doStepHere(msg.step, msg.value).then(reply);
      return true;
    } else if (msg.type === "jobUpdated" && IS_TOP) {
      bg({ type: "hello" }).then((h) => h && h.job && showJobDone(h.job));
    }
  });

  // ================= панель =================
  let panelRoot = null;
  function panel(html, css = "") {
    let host = document.getElementById(PANEL_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = PANEL_ID;
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
      host.attachShadow({ mode: "open" });
      (document.body || document.documentElement).appendChild(host);
    }
    panelRoot = host.shadowRoot;
    panelRoot.innerHTML = `<style>
      .p{width:300px;max-height:80vh;overflow:auto;background:#1c1510;color:#f1e9dd;border-radius:12px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
      .h{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px;gap:6px}
      .g{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}
      button{border:0;border-radius:8px;padding:8px;font:inherit;cursor:pointer;background:#3a3025;color:#f1e9dd}
      button.a{background:#d18b56;color:#1c1108;font-weight:700}
      button.ok{background:#3f7a52;color:#fff;font-weight:700}
      button.mini{padding:2px 8px}
      .w{width:100%;margin-top:6px}
      .info{background:#2a2119;border-radius:8px;padding:8px;line-height:1.45}
      .code{font-family:Consolas,monospace;font-weight:700;color:#d18b56}
      small{color:#ab9d8c;display:block;line-height:1.4;margin-top:6px}
      .err{color:#ef8a72}.good{color:#6ec98a}
      ${css}</style><div class="p">${html}</div>`;
    panelRoot.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
    const mv = panelRoot.getElementById("mv");
    if (mv) mv.onclick = () => { const l = host.style.left === "16px"; host.style.left = l ? "" : "16px"; host.style.right = l ? "16px" : ""; };
    const mn = panelRoot.getElementById("mn");
    if (mn) mn.onclick = () => { const b = panelRoot.getElementById("body"); b.style.display = b.style.display === "none" ? "" : "none"; };
    return panelRoot;
  }
  const $p = (id) => panelRoot && panelRoot.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ================= ВЫСТАВЛЕНИЕ =================
  let job = null, running = false, decision = null, lastCheck = { input: null, idx: -9 };

  function jobPanel() {
    const ad = job.ad;
    panel(`<div class="h"><span>Donini · ${esc(job.site.name)}</span><span><button class="mini" id="mv">⇆</button> <button class="mini" id="mn">—</button></span></div>
      <div id="body">
        <div class="info"><span class="code">${esc(job.code)}</span> · ${esc(ad.price)} ${esc(ad.currency)} · фото: ${job.photos.length}<br>${esc(ad.title)}</div>
        <small id="st">Заполняю форму…</small>
        <div id="errbox" style="display:none"><div class="g"><button id="retry">Повторить шаг</button><button id="skipstep">Пропустить шаг</button></div></div>
        <small>Вставить вручную в поле, где курсор:</small>
        <div class="g"><button data-k="title">Название</button><button data-k="body">Описание</button><button data-k="price">Цена</button><button data-k="photos">Фото</button></div>
        <button class="ok w" id="done">✓ Опубликовал — отметить</button>
        <button class="w" id="skipsite">Пропустить этот сайт</button>
      </div>`);
    panelRoot.querySelectorAll("[data-k]").forEach((b) => (b.onclick = async () => {
      const k = b.dataset.k;
      if (k === "photos") { status("Загружаю фото…"); const n = await uploadFiles(null, toFiles(await bg({ type: "photos", urls: job.photos }))); status(`Фото: ${n}`); return; }
      if (!lastField || !isConnectedEl(lastField)) { status("Сначала кликните в поле на сайте.", true); return; }
      insertText(lastField, String(job.ad[k] ?? ""));
    }));
    $p("done").onclick = async () => { await bg({ type: "manualDone", url: location.href }); job.status = "done"; showJobDone(job); };
    $p("skipsite").onclick = async () => { await bg({ type: "skipSite" }); job.status = "skipped"; showJobDone(job); };
    $p("retry").onclick = () => { decision = "retry"; };
    $p("skipstep").onclick = () => { decision = "skip"; };
  }
  function status(t, err) { const s = $p("st"); if (s) { s.textContent = t; s.className = err ? "err" : ""; } }
  function showJobDone(j) {
    if (!["done", "skipped"].includes(j.status)) return;
    panel(`<div class="h"><span>Donini · ${esc(j.site.name)}</span><button class="mini" id="mn">—</button></div><div id="body">
      <div class="info ${j.status === "done" ? "good" : ""}">${j.status === "done" ? "✅ Товар " + esc(j.code) + " отмечен как выставленный" : "Сайт пропущен для товара " + esc(j.code)}</div>
      <small>${j.batch ? "Пачка: через пару секунд здесь откроется следующий товар. Закрыть вкладку — остановить пачку." : "Эту вкладку можно закрыть."}</small></div>`);
  }

  // «Опубликовать» не может стоять раньше, чем заполнена форма. Если при записи так отметилась
  // кнопка «Подать объявление» в шапке сайта (marktplaats: «Plaats advertentie»), это обычный клик,
  // иначе нажатие на неё засчитывалось как публикация и пачка сразу переходила к следующему товару.
  // А последняя кнопка формы («Plaats je advertentie») — это и есть публикация: её нажимаете вы.
  function fixPublishSteps(list) {
    const steps = (list || []).map((x) => ({ ...x }));
    const firstFill = steps.findIndex((x) => x.action === "fill" || x.action === "upload");
    steps.forEach((x, k) => { if (x.action === "publish" && firstFill >= 0 && k < firstFill) x.action = "click"; });
    if (!steps.some((x) => x.action === "publish")) {
      for (let k = steps.length - 1; k > firstFill && k >= steps.length - 3; k--) {
        if (steps[k].action === "click" && PUBLISH_RE.test(steps[k].label || "")) { steps[k].action = "publish"; break; }
      }
    }
    return steps;
  }

  // Некоторые сайты (Njuškalo — дерево категорий) показывают элементы только во вкладке, которая на экране.
  // Если шаг не находит элемент, а вкладка в фоне, — один раз на шаг переключаемся на неё и повторяем.
  // OLX после загрузки фото сам заполняет параметры и описание («Z pomocą sztucznej inteligencji…»)
  // примерно через 5–10 сек — и затирает то, что мы успели выбрать. Ждём, пока он закончит, и только потом идём дальше.
  async function waitSiteAutofill(i, n) {
    if (!/(^|\.)olx\.(pl|pt|ro|bg|ua|kz|uz)$/.test(location.hostname)) return;
    const AI_RE = /sztucznej inteligencji|inteligência artificial|inteligen[țt][ăa] artificial|изкуствен интелект|штучн\S* інтелект|искусственн\S* интеллект/i;
    // 1) ждём, пока ВСЕ фото реально загрузятся на OLX (у загруженного фото адрес olxcdn вместо локального)
    const want = Math.min(n || 1, 8); // OLX принимает максимум 8 фото
    const uploaded = () => qsaDeep('[data-testid^="PhotoItem"]')
      .filter((it) => Array.from(it.querySelectorAll("img")).some((im) => /^https?:/.test(im.src || ""))).length;
    const t1 = Date.now();
    let last = -1, lastChange = Date.now();
    while (Date.now() - t1 < 180000 && !unloading) {
      const k = uploaded();
      if (k !== last) { last = k; lastChange = Date.now(); }
      status(`Шаг ${i + 1}: OLX загружает фото — ${k} из ${want}…`);
      if (k >= want) break;
      // часть фото OLX может не принять (дубли, размер) — если загрузка остановилась, дальше не ждём
      const busy = qsaDeep('progress, [role="progressbar"]').filter((e) => !isPanel(e) && visible(e)).length +
        qsaDeep('[data-testid^="PhotoItem"] img').filter((im) => /^blob:/.test(im.currentSrc || im.src || "")).length;
      if (k > 0 && !busy && Date.now() - lastChange > 6000) break;
      if (Date.now() - lastChange > 25000) break;
      await sleep(500);
    }
    // 2) после загрузки OLX сам заполняет поля по фото — ждём его и только потом ставим своё
    status(`Шаг ${i + 1}: жду, пока OLX сам заполнит поля по фото…`);
    const t2 = Date.now();
    while (Date.now() - t2 < 15000 && !unloading) {
      if (AI_RE.test(document.body.innerText || "")) { await sleep(3500); return; }
      await sleep(400);
    }
  }

  // Перед публикацией ещё раз проверяем галочки из записи: сайт (например, OLX после автозаполнения
  // или выбора доставки) мог сам их снять — ставим обратно, как было записано.
  // Кнопки-переключатели вида «Nowe»/«Używane» на OLX: записан клик по [data-testid="…_unactive"].
  // Если кнопка уже выбрана (стала «…_active» — например, OLX выбрал её сам), повторный клик её СНИМЕТ.
  function toggleOf(st) {
    if (!st || st.action !== "click") return null;
    for (const sel of st.selectors || []) {
      const m = sel.match(/^\[data-testid="(.+?)_unactive"\]$/);
      if (m) return { on: `[data-testid="${m[1]}_active"]`, off: sel, name: m[1] };
    }
    return null;
  }
  const toggleIsOn = (t) => qsaDeep(t.on).some((e) => !isPanel(e));
  async function recheckBoxes(steps, upto) {
    for (let k = 0; k < upto; k++) {
      const tg = toggleOf(steps[k]);
      if (tg && !toggleIsOn(tg)) {
        const off = qsaDeep(tg.off).find((e) => !isPanel(e) && visible(e));
        if (off) {
          status(`«${steps[k].label || ""}» сбросилось — выбираю обратно…`);
          bg({ type: "stepError", text: `«${(steps[k].label || "").slice(0, 30)}» сбросилось само — выбрал обратно` });
          clickEl(off); await sleep(700);
        }
      }
    }
    for (let k = 0; k < upto; k++) {
      const st = steps[k];
      if (!st || st.action !== "check" || st.optional || isTreeStep(st)) continue;
      const want = st.value !== false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const el = await locate(st, 1500);
        const inp = el && (checkInputOf(el) || el);
        if (!inp || !isCheck(inp) || inp.checked === want) break;
        status(`Галочка «${st.label || ""}» снялась — ставлю обратно…`);
        if (!attempt) bg({ type: "stepError", text: `галочка «${(st.label || "").slice(0, 40)}» снялась сама — поставил обратно` });
        const lab = (inp.labels && inp.labels[0]) || inp.closest("label");
        clickEl(visible(inp) || !lab ? inp : lab);
        await sleep(700);
      }
    }
  }

  // шаг дерева категорий:переключатель с общим именем на всех уровнях + «адрес» пункта (li:nth-of-type…)
  const isTreeStep = (s) => !!s && s.action === "check" && s.value !== false &&
    /name="/.test((s.selectors || [])[0] || "") && (s.alt || []).some((a) => /li:nth-of-type\(\d+\)/.test(a));
  const frontTried = new Map();
  const NEEDS_VISIBLE = /(^|\.)(olx\.(pl|pt|ro|bg|ua|kz|uz)|njuskalo\.hr)$/;
  let warnedHidden = false;
  // окно перекрыто другими окнами, и браузер запущен без фонового режима: вкладка уже активна, но страница
  // всё равно «не видна». Второй раз 8 сек не ждём — это ничего не даст, только тормозит.
  let occluded = false;
  async function bringTabToFront(i) {
    if (!document.hidden || (frontTried.get(i) || 0) >= 3) return false;
    frontTried.set(i, (frontTried.get(i) || 0) + 1);
    if (occluded) { await bg({ type: "focusMe" }); await sleep(600); return !document.hidden; }
    status(`Шаг ${i + 1}: сайт не работает в фоновой вкладке — переключаюсь на неё…`);
    await bg({ type: "focusMe" });
    const end = Date.now() + 8000;
    while (document.hidden && Date.now() < end && !unloading) await sleep(250);
    if (document.hidden) { occluded = true; return false; }
    await sleep(800);
    return true;
  }

  async function runJob() {
    if (running) return;
    running = true;
    jobPanel();
    const steps = fixPublishSteps(job.steps);
    if (!steps.length) { status("Для этого сайта ещё нет сценария. Заполните вручную кнопками ниже или запишите сценарий (значок Donini → «Записать»).", true); return; }
    watchManualPublish(steps);
    let files = null;
    const treeRedo = new Map();
    // замер времени: шаги дольше 8 сек пишем в журнал, чтобы видеть, где сайт тормозит
    let tStep = 0, tPrev = -1;
    const timeStep = () => {
      if (tPrev >= 0 && Date.now() - tStep > 8000) {
        const sp = steps[tPrev] || {};
        bg({ type: "stepTime", text: `шаг ${tPrev + 1} «${(sp.label || sp.action || "").slice(0, 30)}» — ${Math.round((Date.now() - tStep) / 1000)} сек` });
      }
    };
    for (let i = job.idx; i < steps.length; i++) {
      if (unloading) return;
      const st = steps[i];
      timeStep(); tStep = Date.now(); tPrev = i;
      status(`Шаг ${i + 1} из ${steps.length}: ${st.label || st.action}`);
      // OLX и Njuškalo выпадающие списки/категории рисуют только во вкладке «на экране».
      // Перед такими шагами делаем эту вкладку активной в её окне (окно поверх НЕ выводим в фоновом режиме).
      if (NEEDS_VISIBLE.test(location.hostname) && ["click", "pick", "check", "choose"].includes(st.action) && document.hidden) {
        const ok = await bringTabToFront(i);
        if (!ok && document.hidden && !warnedHidden) {
          warnedHidden = true;
          bg({ type: "stepError", soft: true, text: `товар ${job.code}: вкладка не видна (окно выставления закрыто другим окном) — сайт ждёт. Браузер запущен без фонового режима: в окне программы нажмите «🔄 Перезапустить браузер правильно» (сначала остановите авто-режим)` });
        }
      }
      try {
        if (st.action === "goto") {
          if (i === 0) { await bg({ type: "setIdx", idx: 1 }); continue; }
          await bg({ type: "setIdx", idx: i + 1 });
          location.href = render(st.url, job.ad);
          return;
        }
        if (st.action === "wait") { await sleep(st.ms || 1000); await bg({ type: "setIdx", idx: i + 1 }); continue; }
        // выбор пункта в обычном списке <select> по ТЕКСТУ (номер списка — index), например категория на Jófogás,
        // если сайт сам её не предложил. onlyIfEmpty — только если в списке ещё ничего не выбрано.
        if (st.action === "selectText") {
          let sel = null;
          const t0 = Date.now(), tmo = st.timeout || 5000;
          while (!sel && Date.now() - t0 < tmo && !unloading) {
            for (const css of st.selectors || []) {
              const all = qsaDeep(css).filter((e) => e.tagName === "SELECT" && !isPanel(e));
              if (all[st.index || 0]) { sel = all[st.index || 0]; break; }
            }
            if (!sel) await sleep(400);
          }
          if (!sel) { if (st.optional) { await bg({ type: "setIdx", idx: i + 1 }); continue; } throw new Error(`не найден список «${st.label || st.text}»`); }
          const cur = sel.selectedOptions[0];
          const empty = sel.selectedIndex <= 0 || !cur || /válassz|válaszd|select|choose|wybierz|vyberte|alege|kies|selecciona|odaberi/i.test(cur.text || "");
          if (!st.onlyIfEmpty || empty) {
            const want = cleanText(st.text).toLowerCase();
            const opt = Array.from(sel.options).find((o) => cleanText(o.text).toLowerCase() === want);
            if (opt) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("input", { bubbles: true }));
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              await sleep(1200); // следующий уровень списка подгружается
            } else if (!st.optional) throw new Error(`в списке нет пункта «${st.text}»`);
          }
          await bg({ type: "setIdx", idx: i + 1 });
          continue;
        }
        if (st.optional) {
          // необязательный шаг (например, окно «продолжить старый черновик?») — если его нет, просто идём дальше
          const el = await locate(st, st.timeout || 4000);
          if (el) { clickEl(el); await sleep(rnd(900, 1400)); }
          await bg({ type: "setIdx", idx: i + 1 });
          continue;
        }
        if (st.action === "choose") {
          // выбор переключателя (radio) по его подписи: состояние товара, категория из предложенных сайтом…
          status(`Шаг ${i + 1}: ${st.label || "выбор"}…`);
          await chooseRadio(st);
          await bg({ type: "setIdx", idx: i + 1 });
          await sleep(rnd(300, 600));
          continue;
        }
        if (st.action === "pick") {
          status(`Шаг ${i + 1}: ${st.field} → ${st.option}`);
          await pickInList(st);
          await bg({ type: "setIdx", idx: i + 1 });
          await sleep(rnd(300, 600));
          continue;
        }
        // записанная пара «клик по выпадающему списку» + «клик по пункту» — выбираем пункт надёжно
        // (только когда по записанному селектору находится сразу несколько одинаковых списков, как «Selecionar» на OLX.pt;
        //  если не получилось — шаги выполняются как раньше)
        const nx = steps[i + 1];
        if (st.action === "click" && nx && nx.action === "click" && looksLikeListOpener(st)) {
          const option = optionTextOf(nx);
          const hint = option ? await locate(st, 4000) : null;
          // список уже стоит на нужном пункте (OLX сам выбрал «Męskie» по фото, и поле «Wybierz» пропало) —
          // оба шага пропускаем сразу, а не ждём поле по минуте
          if (!hint && option && optionAlreadyShown(option)) {
            status(`Шаг ${i + 1}: «${option}» уже выбрано — пропускаю`);
            await bg({ type: "setIdx", idx: i + 2 });
            i++;
            continue;
          }
          const same = hint && isListControl(hint) && (st.selectors || []).some((s) =>
            resolveOne(s).filter((e) => !isPanel(e) && visible(e) && isListControl(e)).length > 1);
          if (same) {
            status(`Шаг ${i + 1}: выбираю «${option}» в списке…`);
            if (await pickPair(st, option)) {
              await bg({ type: "setIdx", idx: i + 2 });
              i++;
              await sleep(rnd(300, 600));
              continue;
            }
          }
        }
        // клик по окну, которое бывает не всегда (например, OLX.pt: «продолжить черновик?» → «Não, recomeçar»):
        // если окна нет, а поле следующего шага уже на месте — шаг просто пропускаем
        const dialogLike = /^(não|nao|no|nein|nie|nem|ne|non|nee)\b|recomeç|ignorar|neu beginnen|újrakezd|start over|zavřít|schließen|bezár/i;
        if (st.action === "click" && nx && ["fill", "upload", "pick"].includes(nx.action) &&
            (st.optional || dialogLike.test(st.label || "") || dialogLike.test(optionTextOf(st)))) {
          const t = Date.now() + 20000;
          let el = null, skip = false;
          while (!el && Date.now() < t && !unloading) {
            el = await locate(st, 1200);
            if (!el && Date.now() > t - 16000) { const n = await locate(nx, 300); if (n && uncovered(n)) skip = true; }
            if (skip) break;
          }
          if (skip) { await bg({ type: "setIdx", idx: i + 1 }); continue; }
          if (el) { await bg({ type: "setIdx", idx: i + 1 }); clickEl(el); await sleep(rnd(700, 1200)); continue; }
        }
        const isBody = st.action === "fill" && /\{body\}/.test(st.value || "");
        if (isBody && (hasRichEditor() || (st.selectors || []).some((s) => /tinymce|mce|cke/i.test(s)))) {
          // редактор с панелью (TinyMCE и т.п., как на vatera.hu) — вставляем его же командой
          status(`Шаг ${i + 1}: вставляю описание в редактор…`);
          let ok = false;
          const t = Date.now() + 15000;
          while (!ok && Date.now() < t && !unloading) { ok = await fillRichEditor(render(st.value, job.ad)); if (!ok) await sleep(1000); }
          if (ok) { await bg({ type: "setIdx", idx: i + 1 }); await sleep(rnd(300, 600)); continue; }
        }
        if ((st.frame || st.frameSel) && st.action !== "upload") {
          const done = await stepInSameOriginFrame(st, render(st.value, job.ad));
          if (done) { await bg({ type: "setIdx", idx: i + 1 }); await sleep(rnd(300, 600)); continue; }
          let r = await bg({ type: "frameStep", step: st, value: render(st.value, job.ad) });
          if ((!r || !r.ok) && isBody && await fillDescriptionAnywhere(render(st.value, job.ad))) r = { ok: true };
          if (!r || !r.ok) throw new Error(`не найден «${st.label || st.action}» во фрейме`);
          await bg({ type: "setIdx", idx: i + 1 });
          await sleep(rnd(300, 600));
          continue;
        }
        // для кликов по пунктам списков долго не ждём — сразу пробуем пролистать список
        // Пункт дерева/списка-переключателей (Njuškalo: категории «Od glave do pete → Modni dodaci → …»):
        // у всех уровней одно и то же имя поля, поэтому по нему нельзя понять, какой пункт нужен —
        // ищем по подписи пункта и его месту в списке (это записано в alt).
        if (st.action === "check" && (st.alt || []).length && st.value !== false) {
          const same = resolveOne((st.selectors || [])[0] || "").filter((e) => !isPanel(e));
          if (same.length !== 1 && /name="/.test((st.selectors || [])[0] || "")) {
            // дерево категорий (Njuškalo) рисуется только во вкладке на экране — сразу выводим её вперёд
            if (document.hidden) await bringTabToFront(i);
            // 1) по подписи / месту, как записано; 2) если сайт был на другом языке при записи
            //    (Chrome переводил страницу) — по номеру уровня и номеру пункта в нём
            // только настоящие пункты списка (с переключателем внутри) — не ссылки меню с таким же текстом
            const treeName = (((st.selectors || [])[0] || "").match(/name="([^"]+)"/) || [])[1];
            const isItem = (e) => { const c = e && checkInputOf(e); return !!c && (!treeName || c.name === treeName.replace(/\\/g, "")); };
            const altSels = (st.alt || []).filter((s) => !/^text="/.test(s));
            let lab = null;
            for (const t0 = Date.now(); !lab && Date.now() - t0 < 3000 && !unloading; ) {
              const c = await locate({ action: "click", selectors: altSels }, 400);
              if (c && isItem(c)) lab = c; else await sleep(300);
            }
            lab = lab || await pickByLevel(st, 12000);
            if (lab) {
              const inp = checkInputOf(lab);
              if (!(inp && isCheck(inp) && inp.checked)) clickEl(lab);
              await bg({ type: "setIdx", idx: i + 1 });
              await sleep(rnd(1000, 1500)); // следующий уровень списка подгружается
              continue;
            }
            // пункт не найден: если вкладка в фоне — переключаемся на неё и пробуем ещё раз;
            // по общему имени поля НЕ кликаем (это был бы случайный пункт)
            if (await bringTabToFront(i)) { i--; continue; }
            throw new Error(`не найден пункт «${st.label || ""}»`);
          }
        }
        let el = await locate(st, isBody ? 8000 : st.action === "click" && i > 0 && steps[i - 1].action === "click" ? 5000 : 20000);
        if (unloading) return;
        if (!el && isBody) {
          status(`Шаг ${i + 1}: ищу поле описания…`);
          if (await fillDescriptionAnywhere(render(st.value, job.ad))) { await bg({ type: "setIdx", idx: i + 1 }); await sleep(rnd(300, 600)); continue; }
        }
        if (!el && st.action === "click") {
          // 1) пункт есть в открытом списке, но ниже — листаем список
          status(`Шаг ${i + 1}: ищу «${st.label || ""}» в списке…`);
          el = await scrollSearch(st);
        }
        if (!el && i > 0 && steps[i - 1].action === "click") {
          const prev = await locate(steps[i - 1], 3000);
          if (prev) {
            // 2) список не открылся — открываем ещё раз
            status(`Шаг ${i + 1}: открываю список ещё раз…`);
            clickEl(prev); await sleep(1200);
            el = await locate(st, 4000) || await scrollSearch(st);
            // 3) список с поиском: печатаем название пункта, чтобы он отфильтровался
            if (!el && st.label) {
              const box = isTextField(prev) && !prev.readOnly ? prev : (prev.querySelector && prev.querySelector("input:not([readonly])"));
              if (box) { insertText(box, st.label); await sleep(900); el = await locate(st, 5000) || await scrollSearch(st); }
            }
          }
        }
        // кнопка после дерева категорий («NASTAVI» на Njuškalo) ещё неактивна — ждём, пока сайт её включит
        if (el && el.disabled && isTreeStep(steps[i - 1])) {
          const t = Date.now() + 8000;
          while (el.disabled && Date.now() < t && !unloading) await sleep(400);
          if (el.disabled) el = null;
        }
        // кнопки нет / не включилась — значит, категория выбралась не до конца: проходим дерево ещё раз
        if (!el && isTreeStep(steps[i - 1]) && (treeRedo.get(i) || 0) < 2) {
          treeRedo.set(i, (treeRedo.get(i) || 0) + 1);
          let k = i - 1;
          while (k > 0 && isTreeStep(steps[k - 1])) k--;
          status(`Шаг ${i + 1}: категория выбрана не до конца — выбираю её ещё раз…`);
          if (document.hidden) await bringTabToFront(i);
          i = k - 1;
          continue;
        }
        if (!el && await bringTabToFront(i)) { i--; continue; }
        if (!el) {
          // что видно на странице — чтобы по уведомлению было понятно, почему сайт не пошёл дальше
          const errs = visibleFormErrors().slice(0, 2).map((t) => t.slice(0, 80));
          throw new Error(`не найден элемент «${st.label || (st.selectors || [])[0] || st.action}»` +
            (errs.length ? ` — на странице: ${errs.join("; ")}` : ` (страница: ${location.pathname.slice(0, 40)})`));
        }
        if (st.action === "publish") {
          await recheckBoxes(steps, i);
          await sleep(1500);
          await recheckBoxes(steps, i);
          waitPublish(el, i);
          return;
        }
        if (st.action === "check") {
          const inp = checkInputOf(el) || el;
          const want = st.value !== false;
          if (isCheck(inp) ? inp.checked !== want : true) {
            // кликаем по видимому элементу: сама галочка или её подпись
            const lab = (inp.labels && inp.labels[0]) || inp.closest("label");
            clickEl(visible(inp) || !lab ? inp : lab);
          }
          await bg({ type: "setIdx", idx: i + 1 });
          await sleep(rnd(300, 600));
          continue;
        }
        if (st.action === "click") {
          const tg = toggleOf(st);
          if (tg && toggleIsOn(tg)) {
            // уже выбрано (OLX сам поставил «Nowe») — не кликаем, иначе снимем выбор
            await bg({ type: "setIdx", idx: i + 1 });
            continue;
          }
          const ci = checkInputOf(el);
          if (ci && lastCheck.input === ci && lastCheck.idx === i - 1) {
            // старая запись: тот же чекбокс кликнут дважды (подпись + сама галочка) — второй раз пропускаем
            await bg({ type: "setIdx", idx: i + 1 });
            continue;
          }
          await bg({ type: "setIdx", idx: i + 1 });
          // последний шаг записи — клик по кнопке, которая и публикует (Vatera «TOVÁBB ➔», Jófogás «Feladom a hirdetést»),
          // а отдельной «публикации» в записи нет: считаем этот клик публикацией, чтобы товар отметился выставленным
          if (i === steps.length - 1 && !steps.some((x) => x.action === "publish")) {
            await bg({ type: "publishClicked", url: location.href });
            status("Нажал последнюю кнопку — жду, пока сайт откроет следующую страницу, и отмечу товар выставленным…");
          }
          const link = el.closest && el.closest("a[href]");
          const href = link ? link.getAttribute("href") || "" : "";
          const leaves = link && !/^(#|javascript:)/i.test(href) && link.target !== "_blank" &&
            (() => { try { const u = new URL(link.href, location.href); return u.origin === location.origin ? u.pathname + u.search !== location.pathname + location.search : true; } catch (e) { return false; } })();
          clickEl(el);
          lastCheck = { input: ci, idx: i };
          if (tg) {
            for (let k = 0; k < 3 && !unloading; k++) {
              await sleep(900);
              if (toggleIsOn(tg)) break;
              const off = qsaDeep(tg.off).find((e) => !isPanel(e) && visible(e));
              if (!off) break;
              status(`Шаг ${i + 1}: «${st.label || ""}» не выбралось — нажимаю ещё раз…`);
              clickEl(off);
            }
          }
          if (leaves) {
            // ссылка на другую страницу: ждём, пока сайт перейдёт, и НЕ делаем следующие шаги на старой странице
            // (иначе следующий шаг находит похожий текст в меню старой страницы и кликает не туда)
            status(`Шаг ${i + 1}: жду, пока откроется страница…`);
            const t = Date.now() + 15000, was = location.href;
            while (!unloading && Date.now() < t && location.href === was) await sleep(250);
            if (unloading) return;
            if (location.href !== was) { await sleep(700); if (unloading) return; } // сайт сменил страницу без перезагрузки
          }
          await sleep(rnd(700, 1200));
          continue;
        }
        if (st.action === "fill") {
          const val = render(st.value, job.ad);
          // поле ещё выключено (vendora.gr: цена включается только после выбора категории) — ждём
          if (el.disabled || el.readOnly) {
            status(`Шаг ${i + 1}: жду, пока поле «${st.label || ""}» станет доступным…`);
            const t = Date.now() + 20000;
            while ((el.disabled || el.readOnly) && Date.now() < t && !unloading) {
              await sleep(500);
              if (!el.isConnected) el = (await locate(st, 1000)) || el;
            }
          }
          // число в поле с маской (AutoNumeric) — через саму маску
          if (/^\s*\d+([.,]\d+)?\s*$/.test(val) && el.tagName === "INPUT") {
            el.setAttribute("data-donini-mask", "1");
            const r = await bg({ type: "setMasked", value: val }).catch(() => null);
            el.removeAttribute("data-donini-mask");
            if (r && r.ok) { fieldLeft(el); await bg({ type: "setIdx", idx: i + 1 }); await sleep(rnd(300, 600)); continue; }
          }
          if (!(await pasteRich(el, val).catch(() => false))) insertText(el, val);
          // пробелы в конце названия: если сайт их «съел» — допечатываем как с клавиатуры
          const tail = val.length - val.trimEnd().length;
          if (tail && "value" in el && el.value !== val) {
            await sleep(150);
            try { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
            const need = val.length - el.value.length;
            if (need > 0) {
              try { document.execCommand("insertText", false, " ".repeat(need)); } catch (e) {}
            }
            await sleep(150);
            if (el.value !== val) status(`Внимание: сайт убирает пробелы в конце названия (вставлено «${el.value}»).`, true);
          }
          fieldLeft(el);
        }
        if (st.action === "select") setSelect(el, st.value, st.label);
        else if (st.action === "upload") {
          status("Загружаю фото…");
          files = files || toFiles(await bg({ type: "photos", urls: job.photos }));
          const n = await uploadFiles(el, files);
          const olx = /(^|\.)olx\.(pl|pt|ro|bg|ua|kz|uz)$/.test(location.hostname);
          if (!olx) await sleep(2000 + n * 600); // OLX: сразу следим за загрузкой, без лишнего ожидания
          if (st.waitUpload || /(^|\.)vatera\.hu$/.test(location.hostname)) await waitUploadsDone(n, i);
          await waitSiteAutofill(i, n);
        }
        await bg({ type: "setIdx", idx: i + 1 });
        await sleep(rnd(300, 600));
      } catch (e) {
        status(`Шаг ${i + 1}: ${e.message}. Сделайте этот шаг сами и нажмите «Пропустить шаг», или «Повторить шаг».`, true);
        bg({ type: "stepError", text: `товар ${job.code}, шаг ${i + 1}: ${e.message}` });
        $p("errbox").style.display = "";
        decision = null;
        // режим «без меня»: сначала сами пробуем шаг ещё раз, потом пропускаем этот сайт (уведомление уйдёт в Telegram)
        const pubNow = await bg({ type: "pubGet" });
        if (pubNow && pubNow.mode === "auto") {
          job.autoRetries = (job.autoRetries || 0) + 1;
          const until = Date.now() + 30000;
          while (!decision && !unloading && Date.now() < until) {
            status(`Шаг ${i + 1}: ${e.message}. 🤖 Через ${Math.ceil((until - Date.now()) / 1000)} сек ${job.autoRetries <= 1 ? "попробую ещё раз" : "пропущу этот сайт"} (или сделайте шаг сами).`, true);
            await sleep(1000);
          }
          if (!decision && !unloading) {
            let reloaded = true;
            try { reloaded = !!sessionStorage.getItem("dp_reload_" + job.code); } catch (e2) {}
            if (job.autoRetries <= 1 && i <= 2 && !reloaded) {
              try { sessionStorage.setItem("dp_reload_" + job.code, "1"); } catch (e2) {}
              // первые шаги (кнопка «Подать объявление»): страница, скорее всего, загрузилась не до конца — обновляем её
              status("🤖 Обновляю страницу и пробую ещё раз…");
              await bg({ type: "setIdx", idx: Math.max(1, i) });
              location.reload();
              return;
            }
            if (job.autoRetries <= 1) decision = "retry";
            else {
              bg({ type: "stepError", soft: true, text: `товар ${job.code}: не получилось и со второй попытки — сайт пропущен` });
              await bg({ type: "skipSite", keep: true });
              status("🤖 Сайт пропущен из-за ошибки — товар остался в очереди для этого сайта.", true);
              return;
            }
          }
        }
        while (!decision && !unloading) await sleep(300);
        $p("errbox").style.display = "none";
        if (decision === "retry") i--;
        else await bg({ type: "setIdx", idx: i + 1 });
      }
    }
    status("Форма заполнена. Проверьте и нажмите «Опубликовать» на сайте, затем «✓ Опубликовал».");
  }

  // Вы доделали форму руками (шаг упал) и сами нажали кнопку публикации сайта —
  // это тоже засчитывается: товар отметится выставленным, как при обычном прохождении сценария.
  let manualWatch = false;
  function watchManualPublish(steps) {
    if (manualWatch) return;
    const pub = steps.find((s) => s.action === "publish");
    if (!pub || !(pub.selectors || []).length) return;
    manualWatch = true;
    let sent = false;
    document.addEventListener("click", (ev) => {
      if (!ev.isTrusted || sent || !job || ["done", "skipped"].includes(job.status)) return;
      const t = deep(ev);
      if (!t || isPanel(t)) return;
      for (const sel of pub.selectors) {
        for (const el of resolveOne(sel)) {
          if (!isPanel(el) && (el === t || el.contains(t) || clickable(t) === el)) {
            sent = true;
            bg({ type: "publishClicked", url: location.href });
            status("Публикую… после перехода сайта на следующую страницу товар отметится сам.");
            return;
          }
        }
      }
    }, true);
  }

  // Ошибки формы / капча, видимые на странице (после «Опубликовать»)
  function visibleFormErrors() {
    const out = [];
    for (const e of qsaDeep('.is-invalid, .invalid-feedback, .has-error, .error-message, .field-error, .alert-danger, [aria-invalid="true"], [role="alert"], .error')) {
      if (isPanel(e) || !visible(e) || e.closest('[class*="success" i], [class*="info" i]')) continue;
      const t = cleanText(e.innerText || "");
      // настоящий текст ошибки — хотя бы несколько букв (а не «-» из пустого списка, как на vendora.gr)
      if ((t.match(/\p{L}/gu) || []).length >= 3) out.push(t);
    }
    const cap = qsaDeep('iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha"], iframe[title*="captcha" i]').some((f) => visible(f));
    if (cap) out.unshift("капча");
    return out;
  }
  // Сайт не переходит на другую страницу после публикации (vendora.gr): понимаем по самой странице —
  // кнопка «Опубликовать» пропала/форма ушла и ошибок нет → выставлено
  let resultWatch = false;
  function watchPublishResult(el) {
    if (resultWatch) return;
    resultWatch = true;
    (async () => {
      let goneSince = 0;
      for (let k = 0; k < 40 && !unloading; k++) {
        await sleep(1000);
        if (!job || ["done", "skipped"].includes(job.status)) return;
        const errs = visibleFormErrors();
        const gone = !el.isConnected || !visible(el);
        if (gone && !errs.length) {
          if (!goneSince) goneSince = Date.now();
          if (Date.now() - goneSince >= 4000) { bg({ type: "manualDone", url: location.href }); return; }
        } else goneSince = 0;
      }
    })();
  }

  function waitPublish(el, i) {
    el.scrollIntoView({ block: "center" });
    el.style.outline = "4px solid #d18b56";
    el.style.outlineOffset = "3px";
    status(`Всё заполнено. Проверьте объявление и нажмите «${cleanText(el.innerText || el.value || "Опубликовать")}» (подсвечено). Капчу, если будет, решите сами.`);
    let sent = false;
    const onClick = (ev) => {
      if (!ev.isTrusted || sent || isPanel(deep(ev))) return;
      const t = deep(ev);
      if (el.contains(t) || t.contains(el) || (clickable(t) === el)) {
        sent = true;
        bg({ type: "publishClicked", url: location.href });
        status("Публикую… после перехода сайта на следующую страницу товар отметится сам.");
        watchPublishResult(el);
      }
    };
    document.addEventListener("click", onClick, true);
    // режим «без меня»: жмём «Опубликовать» сами (через пару секунд — можно успеть остановить)
    (async () => {
      const pub = await bg({ type: "pubGet" });
      if (!pub || pub.mode !== "auto" || sent) return;
      for (let s = 2; s > 0 && !sent && !unloading; s--) {
        status(`🤖 Режим «без меня»: публикую через ${s} сек…`);
        await sleep(1000);
      }
      if (sent || unloading || !el.isConnected) return;
      sent = true;
      bg({ type: "publishClicked", url: location.href, auto: true });
      status("🤖 Нажал «Опубликовать». Жду, пока сайт откроет следующую страницу…");
      clickEl(el);
      watchPublishResult(el);
    })();
  }

  // ================= ЗАПИСЬ =================
  let recording = false, publishNext = false;

  function recPanel(count) {
    panel(`<div class="h"><span>● Запись: ${esc(recName)}</span><span>шагов: <b id="c">${count}</b> <button class="mini" id="mv">⇆</button> <button class="mini" id="mn">—</button></span></div>
      <div id="body">
        <small>Выставляйте как обычно. Текст товара: кликните в поле сайта (курсор мигает), потом кнопку:</small>
        <div class="g"><button data-v="title">Название</button><button data-v="body">Описание</button>
          <button data-v="price">Цена</button><button data-v="size">Размер</button>
          <button data-v="code">Код</button><button id="wait">Пауза 3 сек</button></div>
        <small>Фото: нажмите кнопку загрузки фото на сайте — подставятся образцы, окно выбора файлов не откроется.</small>
        <button class="w" id="pub">Следующий клик = «Опубликовать»</button>
        <button class="w" id="undo">↶ Отменить последний шаг</button>
        <button class="a w" id="done">Готово — сохранить сценарий</button>
        <small id="st">Кнопка публикации запоминается, но НЕ нажимается — тестовое объявление не выйдет.</small>
      </div>`);
    panelRoot.querySelectorAll("[data-v]").forEach((b) => (b.onclick = async () => {
      await flushPending();
      const r = await bg({ type: "recFill", v: b.dataset.v });
      if (r && r.ok) setCount(r.count); else status((r && r.msg) || "Не получилось", true);
    }));
    $p("wait").onclick = async () => setCount(await bg({ type: "recStep", step: { action: "wait", ms: 3000, label: "пауза" } }));
    $p("pub").onclick = () => { publishNext = !publishNext; $p("pub").textContent = publishNext ? "✔ Теперь нажмите «Опубликовать» на сайте" : "Следующий клик = «Опубликовать»"; };
    $p("undo").onclick = async () => { await flushPending(); const r = await bg({ type: "recUndo" }); setCount(r && r.count); };
    $p("done").onclick = async () => {
      await flushPending();
      status("Сохраняю…");
      // OLX: кнопки-параметры (Męskie, Nowe…), которые выбраны на странице, но клика по ним в записи нет
      // (их выбрал сам OLX по фото) — дописываем в сценарий, иначе в следующий раз OLX может выбрать другое
      try {
        const items = qsaDeep('[data-testid^="parameters."][data-testid$="_active"]').filter((e) => !isPanel(e) && visible(e))
          .map((e) => ({ id: e.getAttribute("data-testid").replace(/_active$/, ""), label: cleanText(e.innerText || e.textContent).split(" ").slice(0, 6).join(" ") }));
        if (items.length) await bg({ type: "recToggles", items });
      } catch (e) {}
      const r = await bg({ type: "recDone" });
      status(r && r.ok !== false ? `💾 Сценарий сохранён (${r.steps || ""} шагов). Вкладка закроется.` : `Ошибка: ${(r && (r.error || r.detail)) || "нет связи с программой"}`, !(r && r.ok !== false));
    };
  }
  let recName = "";
  let flushPending = async () => {};
  const setCount = (n) => { const c = $p("c"); if (c && n) c.textContent = n; };

  function startRecordingListeners() {
    recording = true;
    // перехват выбора файлов: окно выбора не открываем, подставляем образцы
    document.addEventListener("click", async (ev) => {
      const t = deep(ev);
      if (!t || t.tagName !== "INPUT" || (t.type || "").toLowerCase() !== "file" || isPanel(t)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const r = await bg({ type: "recUpload", selectors: selectorsFor(t), multiple: !!t.multiple });
      if (r && r.photos) { putFiles(t, toFiles(r.photos)); setCount(r.count); }
    }, true);
    // галочки и переключатели: запоминаем итоговое состояние
    document.addEventListener("change", async (ev) => {
      const el = deep(ev);
      if (!isCheck(el) || isPanel(el)) return;
      const lab = (el.labels && el.labels[0]) || el.closest("label");
      const sels = selectorsFor(el);
      const labSels = lab ? selectorsFor(lab) : [];
      setCount(await bg({ type: "recStep", step: { action: "check", selectors: sels, alt: labSels, value: el.checked,
        label: cleanText((lab && lab.innerText) || el.getAttribute("aria-label") || el.value || "галочка").slice(0, 60) } }));
    }, true);
    // обычные клики. Некоторые выпадающие списки выбирают пункт уже при нажатии кнопки мыши
    // и сразу убирают его со страницы — тогда «клик» не наступает. Поэтому запоминаем элемент
    // при нажатии мыши и записываем его, даже если клик так и не пришёл.
    const isCombo = (e) => e && e.tagName && (e.readOnly || ["combobox", "listbox", "button"].includes(e.getAttribute("role")) ||
                      e.hasAttribute("aria-haspopup") || e.hasAttribute("aria-expanded") || e.getAttribute("inputmode") === "none");
    function describe(target) {
      if (!target || !target.tagName || isPanel(target) || checkInputOf(target)) return null;
      if ((isTextField(target) && !isCombo(target)) || ["SELECT", "OPTION"].includes(target.tagName)) return null;
      if (target.tagName === "INPUT" && (target.type || "").toLowerCase() === "file") return null;
      const el = isCombo(target) ? target : clickable(target);
      if (el.tagName === "INPUT" && isTextField(el) && !isCombo(el)) return null;
      // клик по пустому месту формы/страницы (контейнер с полями внутри) — не шаг
      if (el === target && !publishNext && (["BODY", "HTML", "FORM", "MAIN", "SECTION"].includes(el.tagName) ||
          (el.querySelector && el.querySelector("input, select, textarea, button") && !el.getAttribute("role")))) return null;
      const label = cleanText(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || "").slice(0, 60);
      return { el, label, selectors: selectorsFor(el) };
    }
    let pending = null;
    // записать отложенное нажатие (клик по нему так и не пришёл — элемент исчез)
    flushPending = async () => {
      const d = pending;
      if (!d) return;
      pending = null;
      clearTimeout(d.timer);
      setCount(await bg({ type: "recStep", step: { action: "click", selectors: d.selectors, label: d.label } }));
    };
    document.addEventListener("pointerdown", async (ev) => {
      if (!ev.isTrusted || ev.button !== 0) return;
      const t = deep(ev);
      if (pending && !isPanel(t)) await flushPending();
      const d = describe(t);
      if (!d) return;
      pending = d;
      d.timer = setTimeout(() => { if (pending === d) flushPending(); }, 600);
    }, true);
    document.addEventListener("click", async (ev) => {
      if (!ev.isTrusted) return;
      const target = deep(ev);
      let d = null;
      if (pending && (pending.el === target || pending.el.contains(target) || target.contains(pending.el))) {
        clearTimeout(pending.timer); d = pending; pending = null;
      } else {
        d = describe(target);
      }
      if (!d) return;
      const el = d.el, label = d.label;
      const looksPublish = (el.tagName === "BUTTON" || el.type === "submit" || el.getAttribute("role") === "button") && label.length < 40 && PUBLISH_RE.test(label);
      const isPub = publishNext || looksPublish;
      if (isPub) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        publishNext = false;
        if ($p("pub")) { $p("pub").textContent = "✔ Кнопка запомнена (не нажата). Жмите «Готово»"; $p("pub").style.background = "#3f7a52"; }
      }
      setCount(await bg({ type: "recStep", step: { action: isPub ? "publish" : "click", selectors: d.selectors, label } }));
    }, true);
    // выбор в списках и свой текст
    document.addEventListener("change", async (ev) => {
      const el = deep(ev);
      if (!el || isPanel(el) || (!ev.isTrusted && el.tagName !== "SELECT")) return;
      if (el.tagName === "SELECT") {
        const opt = el.options[el.selectedIndex];
        setCount(await bg({ type: "recStep", step: { action: "select", selectors: selectorsFor(el), value: el.value, label: opt ? cleanText(opt.text) : "" } }));
      } else if (isTextField(el)) {
        setCount(await bg({ type: "recStep", step: { action: "fill", selectors: selectorsFor(el), value: el.value, label: "свой текст" } }));
      }
    }, true);
    document.addEventListener("focusout", async (ev) => {
      const el = deep(ev);
      if (el && el.isContentEditable && !isPanel(el) && el.innerText.trim()) {
        setCount(await bg({ type: "recStep", step: { action: "fill", selectors: selectorsFor(el), value: el.innerText.trim(), label: "свой текст" } }));
      }
    }, true);
  }

  // ================= старт =================
  async function init() {
    const h = await bg({ type: "hello" });
    if (!h) return;
    if (h.rec) {
      startRecordingListeners();
      if (IS_TOP) {
        recName = h.rec.siteName;
        recPanel(h.rec.count);
        setInterval(() => { if (!document.getElementById(PANEL_ID)) recPanel(0); }, 1500);
      }
      return;
    }
    if (IS_TOP && h.job) {
      job = h.job;
      if (["done", "skipped"].includes(job.status)) { showJobDone(job); return; }
      if (job.status === "published_wait") { jobPanel(); status("Ждём подтверждения публикации…"); return; }
      await sleep(rnd(800, 1500)); // даём странице дорисоваться
      runJob();
    }
  }
  // ================= СИНХРОНИЗАЦИЯ С DONINI MANAGER =================
  // Donini Manager хранит шаблоны и правки карточек только в браузере. Когда он открыт в этом Chrome,
  // расширение читает их и отправляет в программу — тексты в программе всегда как в Manager.
  (function managerWatch() {
    let ls = null;
    try { ls = window.localStorage; } catch (e) { return; }
    const read = () => {
      try {
        const ct = ls.getItem("plt_customTypes"), ov = ls.getItem("plt_overrides_v1");
        if (ct === null && ov === null && ls.getItem("plt_productType") === null) return null;
        return { ct: ct || "[]", ov: ov || "{}" };
      } catch (e) { return null; }
    };
    let last = "";
    const tick = async () => {
      const d = read();
      if (!d) return;
      const sig = d.ct + "|" + d.ov;
      if (sig === last) return;
      let customTypes = [], o = {};
      try { customTypes = JSON.parse(d.ct) || []; } catch (e) {}
      try { o = JSON.parse(d.ov) || {}; } catch (e) {}
      const r = await bg({ type: "managerSync", customTypes, titleOverrides: o.titleOverrides || {}, bodyOverrides: o.bodyOverrides || {} });
      if (r && r.ok) last = sig; // программа не ответила — попробуем ещё раз позже
    };
    if (!read()) return; // это не Donini Manager
    tick();
    setInterval(tick, 4000);
    addEventListener("storage", () => tick());
  })();

  // кнопка «🔄 Синхронизировать с Donini Manager» на странице программы (127.0.0.1) просит расширение забрать шаблоны
  if (IS_TOP && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    addEventListener("message", async (ev) => {
      if (ev.source !== window || !ev.data || ev.data.donini !== "syncManager") return;
      const r = await bg({ type: "managerSyncNow" });
      window.postMessage({ donini: "syncResult", result: r || { ok: false, error: "Расширение не ответило — обновите эту страницу" } }, "*");
    });
    // окно программы управляет расширением напрямую: авто-режим, пачки, режим публикации, запись сценария.
    // Разрешены только эти команды; страница программы открыта только на этом компьютере (127.0.0.1).
    const ALLOWED = ["pubGet", "pubSet", "popupState", "autoState", "batchState", "autoStart", "autoStop",
      "batchStart", "batchStop", "start", "record", "managerSyncNow", "extInfo"];
    addEventListener("message", async (ev) => {
      if (ev.source !== window || !ev.data || ev.data.donini !== "ext" || !ev.data.msg) return;
      const { id, msg } = ev.data;
      let r = null;
      if (msg.type === "extInfo") r = { ok: true, version: chrome.runtime.getManifest().version };
      else if (ALLOWED.includes(msg.type)) r = await bg(msg);
      else r = { ok: false, error: "команда не разрешена" };
      window.postMessage({ donini: "extReply", id, result: r }, "*");
    });
    document.documentElement.dataset.doniniExt = chrome.runtime.getManifest().version || "1"; // страница программы видит, что расширение на месте
  }

  // ================= 微商相册 (szwego.com): ТОВАР В ОЧЕРЕДЬ ОДНОЙ КНОПКОЙ =================
  // Наводите мышь на фото товара — появляется кнопка «⬇ В очередь». Нажали — программа скачивает все фото
  // этого товара в «Очередь\<вид товара>\<модель> <размер>», размер из описания («尺寸35*30») подставится сам.
  if (IS_TOP && /(^|\.)szwego\.com$/.test(location.hostname)) (function szwego() {
    const shopId = () => {
      const q = new URLSearchParams(location.search);
      const v = q.get("shopId") || q.get("shop_id");
      if (v) return v;
      const m = location.hash.match(/(?:shop_detail|theme_detail)\/([^/?#]+)/);
      return m ? m[1] : null;
    };
    const keyOf = (u) => { const m = String(u || "").match(/\/([^/?#]+)\.(?:jpe?g|png|webp)/i); return m ? m[1] : null; };
    const cleanUrl = (u) => String(u || "").replace(/\?.*$/, "");
    const isProductImg = (u) => /xcimg\.szwego\.com\/(img|imgHD)\//.test(u || "");
    const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem("donini_sz_" + k); localStorage.setItem("donini_sz_" + k, v); } catch (e) {} return null; };

    // --- плашка: в какой вид товара класть ---
    const host = document.createElement("div");
    host.id = PANEL_ID + "_sz";
    host.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      .c{background:#1c1510;color:#f1e9dd;border-radius:10px;padding:8px 10px;font:13px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35);max-width:330px}
      select{background:#2b221b;color:#f1e9dd;border:1px solid #5a4a3c;border-radius:6px;padding:2px 4px;margin-left:4px}
      .m{margin-top:6px;font-size:12px;color:#e6c9a8;white-space:pre-wrap}
      button{background:#d18b56;color:#fff;border:0;border-radius:7px;padding:5px 10px;margin-top:6px;cursor:pointer;font-weight:600}
      button.s{background:#5a4a3c}
      .r{margin-top:6px}
    </style><div class="c">⬇ Donini — в очередь. Вид товара:<select id="line"><option>…</option></select>
      <div class="r">Один товар: наведите на его фото → «В очередь».</div>
      <div class="r">Целиком раздел: <select id="tag" style="max-width:170px"><option value="">весь альбом</option></select><br>
        <button id="all">⬇ Весь раздел в очередь</button> <button id="stopAll" class="s" style="display:none">Стоп</button></div>
      <div class="m" id="msg"></div></div>`;
    const $ = (id) => root.getElementById(id);
    const say = (t) => { $("msg").textContent = t; };
    let linesLoaded = false;
    async function loadLines() {
      const r = await bg({ type: "szwegoLines" });
      if (!r || !r.ok) { say((r && r.error) || "Программа Donini Poster не отвечает — запустите её."); return; }
      $("line").innerHTML = r.lines.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      if (LS("line") && r.lines.some((l) => l.id === LS("line"))) $("line").value = LS("line");
      linesLoaded = true;
    }
    $("line").onchange = () => LS("line", $("line").value);
    const showHost = () => { if (!document.getElementById(host.id)) document.documentElement.appendChild(host); };
    showHost(); loadLines();
    setInterval(() => { showHost(); if (!linesLoaded) loadLines(); if (tagsFor !== shopId()) loadTags(); }, 3000);

    // --- разделы альбома (男包, 钱包 …) и скачивание раздела целиком ---
    let tagsFor = null, allBusy = false, allStop = false;
    const urlTag = () => new URLSearchParams(location.search).get("tagId") || (location.hash.match(/[?&]tagId=(\d+)/) || [])[1] || "";
    async function loadTags() {
      const sid = shopId();
      tagsFor = sid;
      if (!sid) return;
      try {
        const j = await (await fetch(`/commodity/tags?hasVideo=0&hideUnCategorized=true&albumId=${encodeURIComponent(sid)}`, { credentials: "include" })).json();
        const tags = (j.result && j.result.allTags) || [];
        bg({ type: "szwegoShop", body: { id: sid, name: (document.title || "").trim(), url: location.href.split("?tagId")[0],
          tags: tags.map((t) => ({ id: String(t.tagId), name: t.tagName, count: t.itemCount })) } });
        $("tag").innerHTML = `<option value="">весь альбом</option>` + tags.map((t) => `<option value="${t.tagId}">${esc(t.tagName)} (${t.itemCount})</option>`).join("");
        const ut = urlTag();
        if (ut && tags.some((t) => String(t.tagId) === ut)) $("tag").value = ut;
      } catch (e) {}
    }
    loadTags();
    $("stopAll").onclick = () => { allStop = true; say("Останавливаю…"); };
    // раздел целиком в очередь: кнопкой на странице или командой из окна программы («⬇ Фото товаров»)
    async function runAll(opt) {
      const sid = shopId();
      if (allBusy) return { ok: false, error: "уже идёт скачивание" };
      if (!sid) return { ok: false, error: "не открыт альбом поставщика" };
      if (!linesLoaded) await loadLines();
      if (!linesLoaded) return { ok: false, error: "программа не отвечает" };
      allBusy = true; allStop = false;
      $("all").style.display = "none"; $("stopAll").style.display = "";
      const line = opt.line || $("line").value;
      const onlyNew = opt.only_new !== false;
      const tag = opt.tag != null ? String(opt.tag) : $("tag").value;
      const tagName = opt.tagName || ($("tag").selectedOptions[0] ? $("tag").selectedOptions[0].textContent : "") || "весь альбом";
      let ts = -1, done = 0, skipped = 0, noSize = 0, errors = 0, seenIds = new Set();
      say(`Скачиваю «${tagName}»… (можно остановить кнопкой «Стоп»)`);
      try {
        for (let pages = 0; pages < 500 && !allStop; pages++) {
          const r = await fetch(`/album/personal/all?albumId=${encodeURIComponent(sid)}&noCache=0&timestamp=${ts}` + (tag ? `&tagList=%5B${tag}%5D` : ""), { method: "POST", credentials: "include" });
          const j = await r.json();
          const items = (j.result && j.result.items) || [];
          if (!items.length) break;
          addItems(items);
          for (const it of items) {
            if (allStop) break;
            const id = it.goods_id || it.parent_goods_id;
            const imgs = (it.imgsSrc && it.imgsSrc.length ? it.imgsSrc : it.imgs || []).map(cleanUrl).filter(Boolean);
            if (!id || seenIds.has(id) || !imgs.length || it.isTop || !String(it.title || "").trim()) continue;
            seenIds.add(id);
            const res = await bg({ type: "szwegoItem", body: { line, dest: "queue", shop: "", only_new: onlyNew, need_size: true, item: { id, title: it.title || "", imgs } } });
            if (!res || !res.ok) {
              errors++;
              if (!res || /Failed to fetch|не запущ/i.test(res.error || "")) { say("⚠️ Программа Donini Poster не отвечает — запустите её."); allStop = true; break; }
              continue;
            }
            if (res.skipped) { if (res.reason === "нет размера") noSize++; else skipped++; }
            else done++;
            say(`⬇ «${tagName}»: в очередь ${done}` + (skipped ? `, уже были ${skipped}` : "") + (noSize ? `, без размера ${noSize}` : "") + (errors ? `, ошибок ${errors}` : "") + (res.folder ? `\nпоследний: ${res.folder}` : ""));
          }
          const pg = j.result && j.result.pagination;
          if (!pg || !pg.isLoadMore || !pg.pageTimestamp || pg.pageTimestamp === ts) break;
          ts = pg.pageTimestamp;
        }
        say(`${allStop ? "Остановлено" : "Готово"}: в очередь ${done}` + (skipped ? `, уже были раньше ${skipped}` : "") + (noSize ? `, пропущено без размера в описании ${noSize}` : "") + (errors ? `, ошибок ${errors}` : "") + ".");
      } catch (e) { say("⚠️ " + e.message); errors++; }
      allBusy = false;
      $("all").style.display = ""; $("stopAll").style.display = "none";
      return { ok: true, done, skipped, noSize, errors, stopped: allStop, tagName };
    }
    $("all").onclick = () => runAll({});
    chrome.runtime.onMessage.addListener((m, sender, reply) => {
      if (!m || m.type !== "szwegoRunAll") return;
      runAll(m).then(reply, (e) => reply({ ok: false, error: e.message }));
      return true;
    });

    // --- кнопка над фото ---
    const btn = document.createElement("div");
    btn.id = PANEL_ID + "_szb";
    btn.style.cssText = "position:fixed;z-index:2147483647;display:none;background:#d18b56;color:#fff;font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:16px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.35);user-select:none";
    btn.textContent = "⬇ В очередь";
    document.documentElement.appendChild(btn);
    let target = null, hideT = null, busy = false;
    const imgUrlOf = (el) => {
      if (!el || el.nodeType !== 1) return null;
      if (el.tagName === "IMG" && isProductImg(el.currentSrc || el.src)) return el.currentSrc || el.src;
      const bgi = (el.style && el.style.backgroundImage) || "";
      const m = bgi.match(/url\(["']?([^"')]+)/);
      return m && isProductImg(m[1]) ? m[1] : null;
    };
    document.addEventListener("mouseover", (ev) => {
      if (busy) return;
      let el = ev.target;
      if (el === btn) { clearTimeout(hideT); return; }
      let url = null;
      for (let k = 0; k < 3 && el && !url; k++) { url = imgUrlOf(el); if (!url) el = el.parentElement; }
      if (!url) { if (target) { clearTimeout(hideT); hideT = setTimeout(() => { if (!busy) { btn.style.display = "none"; target = null; } }, 600); } return; }
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return; // аватарки и значки
      clearTimeout(hideT);
      if (!document.documentElement.contains(btn)) document.documentElement.appendChild(btn);
      target = { el, url };
      btn.textContent = "⬇ В очередь";
      btn.style.left = Math.max(4, r.right - 118) + "px";
      btn.style.top = Math.max(4, r.top + 6) + "px";
      btn.style.display = "";
    }, true);

    // --- поиск товара по фото ---
    const apiMap = new Map(); // ключ фото -> товар из списка альбома
    let apiTs = -1, apiDone = false, apiShop = null;
    function addItems(items) {
      for (const it of items || []) {
        const imgs = (it.imgsSrc && it.imgsSrc.length ? it.imgsSrc : it.imgs || []).map(cleanUrl).filter(Boolean);
        const rec = { id: it.goods_id || it.parent_goods_id || keyOf(imgs[0]), title: it.title || "", imgs };
        for (const u of imgs) { const k = keyOf(u); if (k && !apiMap.has(k)) apiMap.set(k, rec); }
      }
    }
    async function findInAlbum(key) {
      const sid = shopId();
      if (!sid) return null;
      // в разделе (男包, 钱包 …) ищем только среди его товаров — так в разы быстрее, чем по всему альбому
      const tag = urlTag() || $("tag").value || "";
      if (apiShop !== sid + "|" + tag) { apiTs = -1; apiDone = false; apiShop = sid + "|" + tag; }
      if (apiMap.has(key)) return apiMap.get(key);
      for (let p = 0; p < 60 && !apiDone; p++) {
        let j = null;
        btn.textContent = `⏳ ищу товар… (${p * 32})`;
        try {
          const r = await fetch(`/album/personal/all?albumId=${encodeURIComponent(sid)}&noCache=0&timestamp=${apiTs}` + (tag ? `&tagList=%5B${tag}%5D` : ""), { method: "POST", credentials: "include" });
          j = await r.json();
        } catch (e) { break; }
        const items = (j && j.result && j.result.items) || [];
        addItems(items);
        const pg = j && j.result && j.result.pagination;
        if (!items.length || !pg || !pg.isLoadMore || !pg.pageTimestamp || pg.pageTimestamp === apiTs) apiDone = true;
        else apiTs = pg.pageTimestamp;
        if (apiMap.has(key)) return apiMap.get(key);
      }
      return null;
    }
    // запасной путь (лента «相册动态», просмотр фото): карточка поста на странице — текст + все его фото
    function cardOf(img) {
      let card = img.parentElement;
      for (let k = 0; k < 10 && card && card !== document.body; k++, card = card.parentElement) {
        const t = (card.innerText || "").trim();
        if (t.length >= 6 && card.querySelectorAll("img").length >= 1) break;
      }
      if (!card || card === document.body) return null;
      const imgs = [];
      for (const i of card.querySelectorAll("img")) { const u = i.currentSrc || i.src; if (isProductImg(u) && !imgs.includes(cleanUrl(u))) imgs.push(cleanUrl(u)); }
      // текст описания — самый длинный блок текста внутри карточки без фото
      let best = "";
      for (const e of card.querySelectorAll("div, p, span, pre")) {
        if (e.querySelector("img")) continue;
        const t = (e.innerText || "").trim();
        if (t.length > best.length) best = t;
      }
      return { id: keyOf(imgs[0]), title: best || (card.innerText || "").trim(), imgs };
    }
    function findInPage(key, el) {
      for (const i of document.querySelectorAll("img")) {
        const u = i.currentSrc || i.src;
        if (i !== el && isProductImg(u) && keyOf(u) === key) { const c = cardOf(i); if (c && c.imgs.length && c.title) return c; }
      }
      return el && el.tagName === "IMG" ? cardOf(el) : null;
    }

    let lastSeen = null;
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (busy || !target) return;
      const key = keyOf(target.url);
      if (!key) return;
      busy = true;
      btn.textContent = "⏳ ищу товар…";
      try {
        let item = await findInAlbum(key);
        // в ленте у поста бывает больше фото, чем в списке; в альбоме — наоборот: берём, где фото больше
        const fromPage = findInPage(key, target.el);
        if (!item || (fromPage && fromPage.imgs.length > item.imgs.length && fromPage.title)) item = item ? { ...item, imgs: fromPage.imgs.length > item.imgs.length ? fromPage.imgs : item.imgs } : fromPage;
        if (!item || !item.imgs.length) throw new Error("не нашёл этот товар — откройте альбом поставщика и попробуйте ещё раз");
        if (!linesLoaded) await loadLines();
        const force = lastSeen === item.id;
        btn.textContent = `⏳ качаю ${item.imgs.length} фото…`;
        const r = await bg({ type: "szwegoItem", body: { line: $("line").value, dest: "queue", shop: "", only_new: !force, need_size: false, item: { id: item.id, title: item.title, imgs: item.imgs } } });
        if (!r || !r.ok) {
          let dead = false;
          try { dead = !chrome.runtime || !chrome.runtime.id; } catch (e) { dead = true; }
          throw new Error(dead ? "расширение обновилось — обновите эту страницу (F5) и нажмите ещё раз"
            : (r && r.error) || "программа Donini Poster не ответила — она запущена?");
        }
        if (r.skipped) {
          lastSeen = item.id;
          btn.textContent = "Уже в очереди. Ещё раз?";
          say("Этот товар уже скачивали. Нажмите кнопку ещё раз, чтобы скачать снова.");
        } else {
          lastSeen = null;
          btn.textContent = r.size ? `✅ ${r.size} cm` : "✅ (размер не найден)";
          say(`✅ «${r.folder}» — фото ${r.photos}` + (r.size ? `, размер ${r.size} cm` : "\nРазмер в описании не нашёл — впишите его в программе.") + (r.failed ? `\n⚠️ не скачалось фото: ${r.failed}` : ""));
        }
      } catch (e) {
        btn.textContent = /F5/.test(e.message) ? "⚠️ нажмите F5" : "⚠️ ошибка — см. слева внизу";
        say("⚠️ " + e.message);
      }
      busy = false;
      setTimeout(() => { if (!busy && btn.textContent !== "Уже в очереди. Ещё раз?") btn.style.display = "none"; }, 2500);
    }, true);
  })();

  init();
})();
