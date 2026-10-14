"""Запись и воспроизведение сценариев выставления объявления.

Сценарий — список шагов:
  goto     {url}
  click    {selectors}
  publish  {selectors}         — клик по «Опубликовать»
  fill     {selectors, value}  — value может содержать {title} {body} {price} {size} {code} {currency}
  select   {selectors, value, label}
  upload   {selectors, multiple} — клик по кнопке загрузки, программа подставляет фото
  wait     {ms}
"""
import asyncio
import random
import re
import time
from datetime import datetime
from pathlib import Path

from . import config as C

CAPTCHA_JS = r"""
() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 30 &&
                        getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; };
  for (const f of document.querySelectorAll('iframe')) {
    const s = (f.src || '') + ' ' + (f.title || '');
    if (/recaptcha\/api2\/bframe|hcaptcha\.com.*challenge|challenges\.cloudflare|captcha-delivery|geo\.captcha|arkoselabs|funcaptcha/i.test(s) && vis(f)) return true;
    if (/recaptcha|hcaptcha/i.test(s) && /challenge|bframe/i.test(s) && vis(f)) return true;
  }
  for (const el of document.querySelectorAll('[id*="captcha" i],[class*="captcha" i]')) {
    if (el.closest('#__dp_rec_panel')) continue;
    if (vis(el) && el.getBoundingClientRect().height > 60 && !/recaptcha-badge|grecaptcha-badge/i.test(el.className)) return true;
  }
  return false;
}
"""

VAR_RE = re.compile(r"\{(title|body|price|size|code|currency)\}")


PUBLISH_WORDS = re.compile(r"zveřejn|opublikuj|veröffentlich|anzeige aufgeben|plaats (je )?advertentie|plaatsen|predaj oglas|objavi oglas|подать объявление|опубликовать|feladás|feladas|publicar|publică|publish|dodaj ogłoszenie", re.I)


def ensure_publish(steps):
    """Если при записи не отметили «Опубликовать», считаем ею последний клик
    (лучше всего — с текстом вроде Zveřejnit / Opublikuj / Veröffentlichen)."""
    steps = [dict(s) for s in steps]
    # «Опубликовать» раньше заполнения формы — это кнопка «Подать объявление» в шапке сайта, а не публикация
    first_fill = next((i for i, s in enumerate(steps) if s["action"] in ("fill", "upload")), None)
    if first_fill is not None:
        for i, s in enumerate(steps[:first_fill]):
            if s["action"] == "publish":
                s["action"] = "click"
    if any(s["action"] == "publish" for s in steps):
        return steps
    clicks = [i for i, s in enumerate(steps) if s["action"] == "click"]
    pick = next((i for i in reversed(clicks[-3:]) if PUBLISH_WORDS.search(steps[i].get("label") or "")), None)
    if pick is not None:
        steps[pick]["action"] = "publish"
    return steps


class StepError(Exception):
    pass


class NeedUser(Exception):
    pass


def render(value, ad):
    return VAR_RE.sub(lambda m: str(ad.get(m.group(1), "")), value or "")


async def human_pause(a=0.4, b=1.2):
    await asyncio.sleep(random.uniform(a, b))


async def has_captcha(page):
    try:
        if await page.evaluate(CAPTCHA_JS):
            return True
        for fr in page.frames[1:]:
            if re.search(r"captcha|challenge", fr.url or "", re.I) and "recaptcha/api2/anchor" not in fr.url:
                el = await fr.frame_element()
                box = await el.bounding_box()
                if box and box["width"] > 100 and box["height"] > 100:
                    return True
    except Exception:
        return False
    return False


class Runner:
    def __init__(self, page, site, ad, browser, notify, log, dry_run=False):
        self.page = page
        self.site = site
        self.ad = ad
        self.browser = browser
        self.notify = notify
        self.log = log
        self.dry_run = dry_run

    async def wait_captcha(self):
        if not await has_captcha(self.page):
            return
        self.log(f"{self.site['name']}: капча — жду, пока вы её решите")
        await self.browser.show(self.page)
        await self.notify(f"⚠️ {self.site['name']}: нужна капча (товар {self.ad['code']}). Откройте окно программы и решите её.")
        deadline = time.time() + 30 * 60
        while time.time() < deadline:
            await asyncio.sleep(3)
            if not await has_captcha(self.page):
                self.log(f"{self.site['name']}: капча решена, продолжаю")
                await asyncio.sleep(1.5)
                await self.browser.hide(self.page)
                return
        raise StepError("капчу не решили за 30 минут")

    def root_for(self, step):
        """Страница или вложенный фрейм (например редактор описания), где лежит элемент."""
        url = step.get("frame")
        if not url:
            return self.page
        base = url.split("?")[0].split("#")[0]
        for fr in self.page.frames:
            if fr.url.split("?")[0].split("#")[0] == base:
                return fr
        for fr in self.page.frames:
            if fr.url.startswith(base.rsplit("/", 1)[0]):
                return fr
        return None

    async def locate(self, step, timeout=25):
        sels = step.get("selectors") or []
        deadline = time.time() + timeout
        while time.time() < deadline:
            root = self.root_for(step)
            for sel in (sels if root else []):
                try:
                    loc = root.locator(sel)
                    n = await loc.count()
                    if n == 0:
                        continue
                    for i in range(min(n, 5)):
                        cand = loc.nth(i)
                        if await cand.is_visible():
                            return cand
                    if step["action"] == "upload" or step["action"] == "fill":
                        return loc.first  # скрытые поля загрузки тоже годятся
                except Exception:
                    continue
            await self.wait_captcha()
            await asyncio.sleep(0.7)
        raise StepError(f"не найден элемент «{step.get('label') or sels[:1]}»")

    async def settle(self):
        try:
            await self.page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:
            pass
        await human_pause()

    async def do_fill(self, loc, value, literal):
        is_ce = await loc.evaluate("el => el.isContentEditable")
        await loc.scroll_into_view_if_needed()
        if is_ce:
            await loc.click()
            await self.page.keyboard.press("Control+A")
            await self.page.keyboard.press("Delete")
            await self.page.keyboard.insert_text(value)
        elif literal and len(value) <= 40:
            # короткий свой текст (город и т.п.) печатаем по буквам — чтобы сработали подсказки сайта
            await loc.fill("")
            await loc.press_sequentially(value, delay=60)
        else:
            await loc.fill(value)

    async def _set_files(self, el, photos):
        """Кладёт фото в поле загрузки. Если поле принимает только одно фото за раз —
        добавляет их по одному, каждый раз заново находя поле (сайт его перерисовывает)."""
        multiple = await el.evaluate("e => !!e.multiple")
        if multiple or len(photos) == 1:
            await el.set_input_files(photos)
            return
        self.log(f"{self.site['name']}: поле фото принимает по одному — добавляю {len(photos)} шт. по очереди")
        await el.set_input_files(photos[0])
        for ph in photos[1:]:
            await asyncio.sleep(2)
            inputs = self.page.locator("input[type=file]")
            n = await inputs.count()
            target = None
            for i in range(n):  # берём поле загрузки картинок (не документов)
                cand = inputs.nth(i)
                acc = (await cand.get_attribute("accept")) or ""
                if not acc or "image" in acc or ".jp" in acc:
                    target = cand
                    break
            if target is None:
                raise StepError("после первого фото не нашлось поле для следующих")
            await target.set_input_files(ph)

    async def do_upload(self, loc, step):
        photos = self.ad["photos"]
        tag = await loc.evaluate("el => el.tagName.toLowerCase() + ':' + (el.type||'')")
        if tag == "input:file":
            await self._set_files(loc, photos)
        else:
            async with self.page.expect_file_chooser(timeout=20000) as fc:
                await loc.click()
            chooser = await fc.value
            if chooser.is_multiple():
                await chooser.set_files(photos)
            else:
                await self._set_files(chooser.element, photos)
        self.log(f"{self.site['name']}: загружено фото: {len(photos)}")
        await asyncio.sleep(2 + len(photos) * 0.8)  # даём сайту дозагрузить фото

    async def wait_user_publish(self, url_before):
        await self.browser.show(self.page)
        await self.notify(f"🖐 {self.site['name']}: товар {self.ad['code']} заполнен. Проверьте и нажмите «Опубликовать».")
        deadline = time.time() + 60 * 60
        while time.time() < deadline:
            await asyncio.sleep(2)
            if self.page.url != url_before:
                await self.browser.hide(self.page)
                return
        raise StepError("публикацию не подтвердили за час")

    async def run(self, steps):
        steps = ensure_publish(steps)
        for i, step in enumerate(steps, 1):
            act = step["action"]
            try:
                if act == "goto":
                    await self.page.goto(render(step["url"], self.ad), wait_until="domcontentloaded", timeout=60000)
                    await self.settle()
                    await self.wait_captcha()
                    continue
                if act == "wait":
                    await asyncio.sleep(step.get("ms", 1000) / 1000)
                    continue
                loc = await self.locate(step)
                if act == "click":
                    await loc.scroll_into_view_if_needed()
                    await loc.click()
                elif act == "fill":
                    raw = step.get("value", "")
                    await self.do_fill(loc, render(raw, self.ad), literal=not VAR_RE.search(raw))
                elif act == "check":
                    want = step.get("value") is not False
                    try:
                        if await loc.is_checked() != want:
                            await loc.set_checked(want, force=True)
                    except Exception:
                        await loc.click(force=True)
                elif act == "select":
                    try:
                        await loc.select_option(value=step.get("value"))
                    except Exception:
                        await loc.select_option(label=step.get("label"))
                elif act == "upload":
                    await self.do_upload(loc, step)
                elif act == "publish":
                    if self.dry_run:
                        await self.browser.show(self.page)
                        self.log(f"{self.site['name']}: тест — остановился перед «Опубликовать»")
                        return None
                    before = self.page.url
                    if self.site.get("confirm_before_publish"):
                        await self.wait_user_publish(before)
                    else:
                        await self.wait_captcha()
                        await loc.scroll_into_view_if_needed()
                        await loc.click()
                        # ждём перехода на страницу «объявление добавлено»
                        for _ in range(30):
                            await asyncio.sleep(1)
                            if self.page.url != before:
                                break
                            await self.wait_captcha()
                    await self.settle()
                    await self.wait_captcha()
                    return self.page.url
                await self.settle()
            except StepError as e:
                raise StepError(f"шаг {i} ({act}): {e}")
            except Exception as e:
                raise StepError(f"шаг {i} ({act}): {e.__class__.__name__}: {str(e).splitlines()[0][:160]}")
        if not self.dry_run:
            raise StepError("в сценарии не отмечена кнопка «Опубликовать» — объявление не выставлено. "
                            "Перезапишите сценарий или отметьте кнопку в «Шаги».")
        self.log(f"{self.site['name']}: ⚠️ в сценарии нет кнопки «Опубликовать»")
        return self.page.url


async def screenshot(page, name):
    C.SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    path = C.SHOTS_DIR / f"{datetime.now():%Y%m%d-%H%M%S}-{name}.png"
    try:
        await page.screenshot(path=str(path), full_page=False)
        return str(path)
    except Exception:
        return None


# ---------------- Запись ----------------
class Recording:
    """Одна сессия записи сценария на странице."""

    def __init__(self, page, site, sample_ad, log):
        self.page = page
        self.site = site
        self.ad = sample_ad
        self.log = log
        self.steps = [{"action": "goto", "url": site["start_url"], "label": "открыть сайт"}]
        self.done = asyncio.Event()
        self.focus = None          # последнее поле, где стоял курсор
        self.var_fields = set()    # поля, куда вставлен текст товара кнопкой панели

    async def start(self):
        js = (Path(__file__).parent / "recorder.js").read_text("utf-8")
        await self.page.expose_binding("__dpRecord", self._record)
        await self.page.expose_binding("__dpSample", lambda src, name: str(self.ad.get(name, "")))
        await self.page.expose_binding("__dpFocus", self._on_focus)
        await self.page.expose_binding("__dpFill", self._fill)
        await self.page.expose_binding("__dpUndo", self._undo)
        await self.page.expose_binding("__dpCount", lambda src: len(self.steps))
        await self.page.expose_binding("__dpDone", lambda src: self.done.set())
        await self.page.add_init_script(js)
        self.page.on("filechooser", self._on_file_chooser)
        self.page.on("close", lambda *_: self.done.set())
        await self.page.goto(self.site["start_url"], wait_until="commit", timeout=90000)

    def _on_focus(self, source, info):
        self.focus = info

    async def _fill(self, source, var):
        names = {"title": "Название", "body": "Описание", "price": "Цена", "size": "Размер", "code": "Код"}
        value = str(self.ad.get(var, "") or "")
        if not value:
            msg = (f"«{names.get(var, var)}» пустое для языка {self.ad.get('lang')}. Проверьте шаблон в "
                   f"«Линии товара» → «Посмотреть текст для страны»" + (" или задайте цену по умолчанию." if var == "price" else "."))
            self.log("Запись: " + msg)
            return {"ok": False, "msg": msg}
        if not self.focus:
            return {"ok": False, "msg": "Сначала кликните в поле на сайте (чтобы там мигал курсор), потом нажмите кнопку."}
        try:
            await self.page.keyboard.press("Control+A")
            await self.page.keyboard.press("Delete")
            await self.page.keyboard.insert_text(value)
        except Exception as e:
            return {"ok": False, "msg": f"Не получилось вставить: {e}"}
        sels = self.focus.get("selectors") or []
        if sels:
            self.var_fields.add(sels[0])
        step = {"action": "fill", "selectors": sels, "value": "{" + var + "}", "label": names.get(var, var)}
        if self.focus.get("frame"):
            step["frame"] = self.focus["frame"]
        self._record(source, step)
        return {"ok": True}

    def _record(self, source, step):
        # ручной ввод в поле, куда уже вставлен текст товара кнопкой, не записываем повторно
        if step.get("action") == "fill" and not str(step.get("value", "")).startswith("{") \
                and (step.get("selectors") or [None])[0] in self.var_fields:
            return len(self.steps)
        self.steps.append(step)
        self.log(f"Запись {self.site['name']}: {step['action']} «{step.get('label', '')}»")
        return len(self.steps)

    def _undo(self, source):
        if len(self.steps) > 1:
            removed = self.steps.pop()
            self.log(f"Запись: отменён шаг {removed['action']}")
        return len(self.steps)

    async def _on_file_chooser(self, fc):
        # клик, открывший окно выбора файлов, превращаем в шаг «загрузить фото»
        await asyncio.sleep(0.4)  # даём дойти записи самого клика
        if self.steps and self.steps[-1]["action"] == "click":
            trig = self.steps.pop()
            self.steps.append({"action": "upload", "selectors": trig["selectors"],
                               "multiple": fc.is_multiple(), "label": "фото"})
        else:
            self.steps.append({"action": "upload", "selectors": ["input[type=file]"],
                               "multiple": fc.is_multiple(), "label": "фото"})
        self.log(f"Запись {self.site['name']}: загрузка фото")
        try:
            photos = self.ad.get("photos") or []
            await fc.set_files(photos if fc.is_multiple() else photos[:1])
            self.log(f"Запись {self.site['name']}: подставлено фото: {len(photos) if fc.is_multiple() else 1}")
        except Exception as e:
            self.log(f"Запись {self.site['name']}: не удалось подставить фото — {e}")
        try:
            await self.page.evaluate("n => { const h=document.getElementById('__dp_rec_panel'); if(h){h.shadowRoot.getElementById('c').textContent=n;} }", len(self.steps))
        except Exception:
            pass
