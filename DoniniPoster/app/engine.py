"""Движок: следит за очередью и запускает «работника» на каждый сайт.

Каждый сайт работает в своей вкладке и в своём темпе (пауза между объявлениями
с случайным разбросом, дневной лимит, рабочие часы), поэтому для сайта это
выглядит как обычный продавец, который добавляет объявления в течение дня.
"""
import asyncio
import importlib.util
import random
import time
import traceback
from collections import deque
from datetime import datetime, date

from . import config as C
from . import images, queue_store, telegram
from .browser import Browser
from .scenario import Recording, Runner, StepError, screenshot
from .templates import build_texts, convert_price


# сайты, где бренд из названия папки сам добавляется в название объявления
BRAND_SITES = {"vatera", "njukalo", "njuskalo"}

class Engine:
    def __init__(self):
        self.cfg = C.load_config()
        self.state = C.load_state()
        self.logs = deque(maxlen=400)
        self.browser = Browser(log=self.log)
        self.browser.proxy = self.cfg.get("proxy", "")
        self.workers = {}       # site_id -> task
        self.pages = {}         # site_id -> page
        self.site_status = {}   # site_id -> текст для интерфейса
        self.last_post = {}     # site_id -> (время последней публикации, случайный разброс -1..1)
        self.recording = None
        self._stop = asyncio.Event()
        # после перезапуска «зависшие» статусы возвращаем в очередь
        for p in self.state["products"].values():
            for s in p["sites"].values():
                if s["status"] == "running":
                    s["status"] = "pending"

    # ---------- служебное ----------
    # что из журнала отправлять в Telegram: поломки, отчёты, окончание работы
    TG_PATTERNS = ("⚠️", "📊", "■ ", "🛑", "❌")
    TG_SKIP = ("Не удалось открыть фото",)

    def log(self, msg):
        line = f"{datetime.now():%H:%M:%S}  {msg}"
        self.logs.append(line)
        print(line, flush=True)
        text = str(msg)
        # итог по каждому товару присылает расширение («✅ Товар … выставлен: 8 из 8 сайтов»)
        want = text.startswith(self.TG_PATTERNS) or text.startswith("✅ Товар") or text.startswith("Ошибка")
        if want and not any(x in text for x in self.TG_SKIP):
            buf = self.__dict__.setdefault("_tg_buf", [])
            if len(buf) < 40:
                buf.append(f"{datetime.now():%H:%M} {text}")

    async def flush_telegram(self):
        """Копит сообщения и шлёт пачкой не чаще раза в 20 сек — чтобы не засыпать чат."""
        buf = self.__dict__.get("_tg_buf") or []
        if not buf:
            return
        last = self.__dict__.get("_tg_last", 0)
        if time.time() - last < 20:
            return
        tg = self.cfg.get("telegram") or {}
        if not tg.get("token") or not tg.get("chat_id"):
            buf.clear()
            return
        msgs, self._tg_buf = buf[:], []
        self._tg_last = time.time()
        text = "Donini Poster\n" + "\n".join(msgs)
        await telegram.send(self.cfg, text[:3900])

    def save(self):
        C.save_state(self.state)

    async def notify(self, text):
        await telegram.send(self.cfg, text)

    @property
    def paused(self):
        return self.state.get("paused", True)

    def set_paused(self, value):
        self.state["paused"] = value
        self.save()
        self.log("⏸ Пауза" if value else "▶ Работа запущена")

    def line(self, line_id):
        return next((l for l in self.cfg["lines"] if l["id"] == line_id), None)

    def today_count(self, site_id):
        return self.state.setdefault("daily", {}).get(str(date.today()), {}).get(site_id, 0)

    def inc_today(self, site_id):
        d = self.state.setdefault("daily", {})
        today = str(date.today())
        for k in list(d):
            if k != today:
                del d[k]
        d.setdefault(today, {})
        d[today][site_id] = d[today].get(site_id, 0) + 1

    def in_work_hours(self):
        a, b = self.cfg.get("work_hours", [0, 24])
        return a <= datetime.now().hour < b

    def scenario_for(self, site, line_id):
        sc = site.get("scenarios") or {}
        return sc.get(line_id) or sc.get("default") or []

    # ---------- объявление ----------
    def build_ad(self, product, site, photos):
        line = self.line(product["line"]) or {}
        lang = site["lang"]
        # бренд из названия папки товара («GUCCI 古奇… 26.5x17x7» -> Gucci). В название объявления добавляется
        # на сайтах с настройкой «title_brand» (по умолчанию — Vatera и Njuškalo), в записи доступен как {brand}.
        from .brands import brand_of_product
        brand = brand_of_product(product)
        use_brand = site.get("title_brand", site.get("id") in BRAND_SITES)
        if product.get("no_brand"):  # в очереди выключено «с брендом» — бренд не ставится нигде
            use_brand, brand = False, ""
        title, body = build_texts(product.get("template") or line.get("template", "bags"), lang, product.get("size", ""),
                                  product["code"], brand=brand if use_brand else "",
                                  custom=self.cfg.get("custom_templates"))
        if use_brand and brand and brand.lower() not in title.lower():
            title = f"{title.rstrip()} {brand}"
        if use_brand and brand:
            title = " ".join(title.split())
        # текст, поправленный вручную для этого товара (кнопка «✏️ Текст» в очереди) — важнее шаблона
        own = (product.get("texts") or {}).get(lang) or {}
        if own.get("title"):
            title = own["title"]
        if own.get("body"):
            body = own["body"]
        title += " " * int(site.get("title_spaces") or 0)  # пробелы после названия (настройка сайта)
        conv = convert_price(float(product.get("price") or 0), lang, self.cfg.get("rates"), site.get("currency"))
        price, cur = conv if conv else ("", "")
        return {"code": product["code"], "title": title, "body": body, "price": price, "currency": cur,
                "size": product.get("size", ""), "photos": photos, "lang": lang, "name": product["name"],
                "brand": brand}

    def sample_ad(self, site, line_id):
        line = self.line(line_id) or self.cfg["lines"][0]
        prod = next((p for p in self.state["products"].values() if p["line"] == line["id"] and p["status"] != "archived"), None)
        if prod:
            photos = images.prepare(prod, self.cfg.get("photo_max_side", 1600), limit=3)
            ad = self.build_ad(prod, site, photos)
        else:
            fake = {"code": "00000", "size": line.get("default_size", ""), "price": line.get("default_price") or 100,
                    "line": line["id"], "name": "образец"}
            ad = self.build_ad(fake, site, [])
        if not ad["photos"]:
            ad["photos"] = images.sample_photos()  # чтобы при записи было что загрузить
        return ad

    # ---------- работник сайта ----------
    def next_product(self, site):
        cands = []
        for p in self.state["products"].values():
            if p["status"] == "archived":
                continue
            s = p["sites"].get(site["id"])
            if s and s["status"] == "pending" and (site.get("type") == "plugin" or self.scenario_for(site, p["line"])):
                from . import photo_qc
                if photo_qc.pending(p, self.cfg) or (p.get("qc_allbad") and (self.cfg.get("photo_qc") or "normal") != "off"):
                    continue
                cands.append(p)
        cands.sort(key=lambda p: p["added"])
        return cands[0] if cands else None

    async def get_page(self, site_id):
        page = self.pages.get(site_id)
        if page is None or page.is_closed():
            page = await self.browser.new_page(self.cfg.get("browser_channel", "chrome"))
            self.pages[site_id] = page
            await self.browser.hide(page)
        return page

    async def post_one(self, site, product, dry_run=False):
        photos = await asyncio.to_thread(images.prepare, product, self.cfg.get("photo_max_side", 1600),
                                         site.get("max_photos") or None)
        while images.LAST_ERRORS:
            self.log("⚠️ " + images.LAST_ERRORS.pop(0))
        if not photos:
            raise StepError("ни одно фото товара не удалось открыть — см. журнал")
        ad = self.build_ad(product, site, photos)
        # плагин без браузера (загрузка на свой сайт через API) — окно браузера не открываем
        page = None if site.get("no_browser") else await self.get_page(site["id"])
        if site.get("type") == "plugin":
            mod = load_plugin(site.get("plugin"))
            return await mod.post(page=page, ad=ad, site=site, engine=self, dry_run=dry_run)
        runner = Runner(page, site, ad, self.browser, self.notify, self.log, dry_run=dry_run)
        return await runner.run(self.scenario_for(site, product["line"]))

    async def site_worker(self, site_id):
        while not self._stop.is_set():
            site = C.get_site(site_id)
            if site and site.get("type") in ("manual", "ext"):
                return
            if not site or not site.get("enabled"):
                self.site_status[site_id] = "выключен"
                return
            own = bool(site.get("independent"))  # свой сайт: работает сам по себе, без общей паузы и рабочих часов
            if self.paused and not own:
                self.site_status[site_id] = "пауза"
                await asyncio.sleep(3)
                continue
            if self.browser.pinned and not own:
                # вы сейчас работаете в окне браузера (запись, вход, тест) — не мешаем
                self.site_status[site_id] = "ждёт: окно браузера открыто для вас"
                await asyncio.sleep(3)
                continue
            if not own and not self.in_work_hours():
                self.site_status[site_id] = "вне рабочих часов"
                await asyncio.sleep(30)
                continue
            if self.today_count(site_id) >= int(site.get("daily_limit") or 9999):
                self.site_status[site_id] = "дневной лимит"
                await asyncio.sleep(60)
                continue
            # паузу считаем по ТЕКУЩИМ настройкам сайта — если вы её поменяли, она сразу учитывается
            last, frac = self.last_post.get(site_id, (0, 0))
            base = float(site.get("min_interval_min") or 0) * 60
            delay = max(5 if own else 20, base + frac * base * float(site.get("jitter_pct") or 0) / 100)
            wait = last + delay - datetime.now().timestamp() if last else 0
            if wait > 0:
                self.site_status[site_id] = f"пауза {int(wait // 60)} мин {int(wait % 60)} с"
                await asyncio.sleep(min(wait, 5))
                continue
            product = self.next_product(site)
            if not product:
                self.site_status[site_id] = "ждёт товары"
                await asyncio.sleep(5)
                continue
            st = product["sites"][site_id]
            st["status"] = "running"
            product["status"] = "working"
            self.save()
            self.site_status[site_id] = f"выставляет {product['code']}"
            self.log(f"{site['name']}: выставляю {product['code']}")
            try:
                url = await self.post_one(site, product)
                st.update(status="done", url=url, at=datetime.now().isoformat(timespec="seconds"), error=None)
                self.inc_today(site_id)
                if own:
                    left = sum(1 for q in self.state["products"].values() if q.get("status") != "archived"
                               and (q["sites"].get(site_id) or {}).get("status") == "pending")
                    self.log(f"✅ Товар {product['code']} загружен на {site['name']} (осталось {left})")
                    if not left:
                        self.log(f"🌐 {site['name']}: все товары из очереди загружены")
                else:
                    self.log(f"✅ {site['name']}: {product['code']} выставлен")
                if not own and queue_store.product_finished(product):
                    n = sum(1 for s in product["sites"].values() if s["status"] == "done")
                    await self.notify(f"✅ Товар {product['code']} выставлен на {n} сайтов")
            except Exception as e:
                msg = str(e) if isinstance(e, StepError) else f"{e.__class__.__name__}: {e}"
                page = self.pages.get(site_id)
                shot = await screenshot(page, f"{site_id}-{product['code']}") if page else None
                st.update(status="error", error=msg[:300], at=datetime.now().isoformat(timespec="seconds"), shot=shot)
                self.log(f"❌ {site['name']}: {product['code']} — {msg}")
                if not isinstance(e, StepError):
                    self.log(traceback.format_exc(limit=2))
                await self.notify(f"❌ {site['name']}: товар {product['code']} не выставлен.\n{msg[:300]}")
            finally:
                if product["status"] == "working":
                    product["status"] = "queued"
                self.save()
            self.last_post[site_id] = (datetime.now().timestamp(), random.uniform(-1, 1))

    # ---------- полуавтомат (помощник в обычном браузере) ----------
    def manual_next(self, site_id, skip_ids=()):
        site = C.get_site(site_id)
        if not site:
            return None, None
        cands = [p for p in self.state["products"].values() if p["status"] != "archived"
                 and p["sites"].get(site_id, {}).get("status") in ("pending", "error") and p["id"] not in skip_ids]
        cands.sort(key=lambda p: p["added"])
        return site, (cands[0] if cands else None)

    def manual_done(self, pid, site_id, url=""):
        p = self.state["products"].get(pid)
        if not p or site_id not in p["sites"]:
            return False
        st = p["sites"][site_id]
        if st.get("edit"):  # исправление уже выставленного объявления — ссылку и дату не трогаем
            ed = st.pop("edit")
            st.update(status="done", error=None, edited=datetime.now().isoformat(timespec="seconds"), title=ed.get("title"))
            self.edit_done = getattr(self, "edit_done", 0) + 1
            self.save()
            site = C.get_site(site_id)
            self.log(f"✏️ {site['name'] if site else site_id}: {p['code']} — название исправлено")
            return True
        st.update(status="done", url=url, at=datetime.now().isoformat(timespec="seconds"), error=None)
        self.inc_today(site_id)
        self.save()
        site = C.get_site(site_id)
        self.log(f"✅ {site['name'] if site else site_id}: {p['code']} выставлен (в вашем браузере)")
        return True

    def ensure_workers(self):
        for site in C.load_sites():
            sid = site["id"]
            task = self.workers.get(sid)
            if site.get("type") in ("manual", "ext"):
                self.site_status[sid] = "в моём браузере (расширение)" if site.get("enabled") else "выключен"
                if task and not task.done():
                    task.cancel()
                continue
            if site.get("enabled") and (task is None or task.done()):
                self.workers[sid] = asyncio.create_task(self.site_worker(sid))
            if not site.get("enabled"):
                self.site_status[sid] = "выключен"

    async def scanner(self):
        last_cleanup = None
        while not self._stop.is_set():
            try:
                self.cfg = C.load_config()
                self.browser.proxy = self.cfg.get("proxy", "")
                ch = await asyncio.to_thread(queue_store.scan, self.cfg, self.state, self.log)
                ch = queue_store.sync_sites(self.cfg, self.state, self.log) or ch
                ch = queue_store.archive_finished(self.cfg, self.state, self.log) or ch
                if last_cleanup != date.today():
                    ch = queue_store.cleanup_old(self.cfg, self.state, self.log) or ch
                    last_cleanup = date.today()
                if ch:
                    self.save()
                self.ensure_workers()
                await self.flush_telegram()
            except Exception as e:
                self.log(f"Ошибка очереди: {e}")
            await asyncio.sleep(2)

    # ---------- запись и тест ----------
    async def start_recording(self, site_id, line_id):
        site = C.get_site(site_id)
        if not site:
            self.log(f"🎥 Запись: сайт {site_id} не найден")
            return
        if self.recording:
            old = self.recording["rec"]
            if old.page.is_closed() or self.recording.get("site") == site_id:
                # прошлая запись зависла (окно закрыли без «Готово») — сбрасываем её
                self.log("🎥 Сбрасываю незавершённую прошлую запись")
                old.done.set()
                await asyncio.sleep(0.5)
                self.recording = None
            else:
                other = C.get_site(self.recording["site"]) or {"name": self.recording["site"]}
                self.log(f"🎥 Сейчас идёт запись {other['name']} — нажмите на её панели «Готово» или закройте ту вкладку")
                return
        self.log(f"🎥 Открываю {site['start_url']} для записи…")
        try:
            page = await self.browser.new_page(self.cfg.get("browser_channel", "chrome"))
        except Exception as e:
            # браузер программы закрыли вручную — запускаем заново
            self.log(f"Браузер не ответил ({e.__class__.__name__}), перезапускаю")
            await self.browser.close()
            self.pages = {}
            page = await self.browser.new_page(self.cfg.get("browser_channel", "chrome"))
        rec = Recording(page, site, self.sample_ad(site, line_id), self.log)
        self.recording = {"site": site_id, "line": line_id, "rec": rec}
        self.browser.pinned = True
        await self.browser.show(page)
        try:
            await rec.start()
        except Exception as e:
            self.log(f"⚠️ {site['name']} открывается медленно или с ошибкой ({str(e).splitlines()[0][:150]}). "
                     f"Окно оставлено открытым — если сайт открылся, просто продолжайте запись. "
                     f"Проверьте адрес сайта и VPN.")
        self.log(f"🎥 Запись сценария: {site['name']} ({'все линии' if line_id == 'default' else line_id})")
        asyncio.create_task(self._finish_recording(rec, site_id, line_id))

    async def _finish_recording(self, rec, site_id, line_id):
        await rec.done.wait()
        site = C.get_site(site_id)
        from .scenario import ensure_publish
        had_pub = any(s["action"] == "publish" for s in rec.steps)
        steps = ensure_publish(rec.steps)
        if not had_pub and any(s["action"] == "publish" for s in steps):
            p = next(s for s in steps if s["action"] == "publish")
            self.log(f"ℹ️ Кнопка «Опубликовать» не была отмечена — считаю ею «{p.get('label', '')}». Если это не так, исправьте в «Шаги».")
        if len(steps) > 1:
            site.setdefault("scenarios", {})[line_id] = steps
            C.save_site(site)
            has_pub = any(s["action"] == "publish" for s in steps)
            self.log(f"💾 Сценарий {site['name']} сохранён: {len(steps)} шагов" +
                     ("" if has_pub else " — ⚠️ не отмечена кнопка «Опубликовать»"))
        else:
            self.log("Запись отменена — шагов нет")
        try:
            await rec.page.close()
        except Exception:
            pass
        if self.recording and self.recording.get("rec") is rec:  # не трогаем уже начатую новую запись
            self.recording = None
            self.browser.pinned = False

    async def test_site(self, site_id, line_id):
        """Прогон сценария на образце БЕЗ публикации: останавливается перед «Опубликовать»."""
        site = C.get_site(site_id)
        try:
            steps = (site.get("scenarios") or {}).get(line_id) or self.scenario_for(site, line_id)
            if not steps:
                raise RuntimeError("для этого сайта ещё нет сценария — сначала «Записать»")
            self.log(f"🧪 Тест {site['name']}: начинаю (без публикации)")
            ad = self.sample_ad(site, line_id)
            self.log(f"🧪 Текст для теста: «{ad['title']}», цена {ad['price']} {ad['currency']}, фото: {len(ad['photos'])}")
            page = await self.browser.new_page(self.cfg.get("browser_channel", "chrome"))
            self.browser.pinned = True  # окно остаётся открытым, пока не нажмёте «Свернуть браузер»
            await self.browser.show(page)
            runner = Runner(page, site, ad, self.browser, self.notify, self.log, dry_run=True)
            await runner.run(steps)
            self.log(f"🧪 Тест {site['name']}: готово, остановился перед «Опубликовать». Проверьте окно — объявление НЕ опубликовано.")
        except Exception as e:
            self.log(f"🧪 Тест {site['name']}: ошибка — {e}")

    async def open_site(self, site_id):
        site = C.get_site(site_id)
        page = await self.browser.new_page(self.cfg.get("browser_channel", "chrome"))
        self.browser.pinned = True  # вход на сайт: окно не сворачивается, пока не нажмёте «Свернуть браузер»
        await self.browser.show(page)
        await page.goto(site["start_url"])

    async def open_browser(self, url="https://chromewebstore.google.com/category/extensions"):
        """Открыть окно браузера программы — например, чтобы поставить VPN-расширение."""
        page = await self.browser.new_page(self.cfg.get("browser_channel", "chrome"))
        self.browser.pinned = True
        await self.browser.show(page)
        await page.goto(url)

    async def run(self):
        self.log("Программа запущена")
        await self.scanner()

    async def shutdown(self):
        self._stop.set()
        for t in self.workers.values():
            t.cancel()
        await self.browser.close()


def load_plugin(name):
    path = C.ROOT / "plugins" / f"{name}.py"
    if not path.exists():
        raise StepError(f"плагин {name}.py не найден в папке plugins")
    spec = importlib.util.spec_from_file_location(f"plugin_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
