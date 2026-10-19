"""Веб-интерфейс программы (открывается в браузере: http://127.0.0.1:8765)."""
import asyncio
import shutil
import os
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse

from . import config as C
from . import images, telegram
from .templates import (ALL_LANGS, LANG_NAMES, build_texts, convert_price, decode_donini_code, list_types)

WEB = Path(__file__).parent / "web"


ALL_BAD = "Все фото недокачанные (файлы обрезаны — размытые/пустые). Скачайте фото этого товара заново или выберите фото в карточке 🗂"
NO_PRICE = "Нет цены — впишите цену в очереди (без цены OLX и другие доски не дают выставить)"


def create_app(engine):
    app = FastAPI(title="Donini Poster")
    # помощник в вашем браузере (olx.pl и т.д.) обращается к программе на этом компьютере
    app.add_middleware(CORSMiddleware, allow_origin_regex=r"https://([a-z0-9-]+\.)*(olx\.(pl|ro|pt|bg|ua|kz|uz)|sbazar\.cz|jofogas\.hu|vatera\.hu|kleinanzeigen\.de|marktplaats\.nl|milanuncios\.com)",
                       allow_methods=["*"], allow_headers=["*"])

    _ext_seen = {}
    _ext_copies = {}  # id расширения → браузер, когда было, отвечает ли через «мост» (новая версия)

    @app.middleware("http")
    async def private_network(request, call_next):
        # запросы от расширения Donini (любой версии) — запоминаем, в каком браузере оно живёт и какая это копия.
        # Окно программы (WebView2/Edge) сюда не попадает: у расширения адрес «chrome-extension://…»
        origin = request.headers.get("origin", "")
        path = request.url.path
        if origin.startswith(("chrome-extension://", "extension://")) or path.startswith("/api/bridge/poll"):
            import time as _t
            ua = request.headers.get("user-agent", "")
            key = request.query_params.get("b") or (
                "yandex" if "YaBrowser" in ua else "edge" if "Edg/" in ua else "opera" if "OPR/" in ua
                else "vivaldi" if "Vivaldi" in ua else "chrome" if "Chrome/" in ua else None)
            ext_id = origin.split("://", 1)[1].strip("/") if "://" in origin else "?"
            if key:
                info = _ext_copies.setdefault(ext_id, {"browser": key, "first": _t.time()})
                info.update(browser=key, last=_t.time())
                if path.startswith("/api/bridge/poll"):
                    info["poll"] = _t.time()
                    info["version"] = request.query_params.get("v")
                _ext_seen[key] = _t.time()
                if engine.cfg.get("_ext_browser") != key and not any(
                        k != key and _t.time() - t < 60 for k, t in _ext_seen.items()):
                    cfg = C.load_config()
                    cfg["_ext_browser"] = key
                    C.save_config(cfg)
                    engine.cfg = C.load_config()
                    engine.log(f"🧩 Расширение Donini работает в браузере: {key}")
        resp = await call_next(request)
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp

    def site_view(s):
        sc = s.get("scenarios") or {}
        return {
            "id": s["id"], "name": s["name"], "lang": s["lang"], "start_url": s["start_url"],
            "enabled": s.get("enabled", True), "type": s.get("type", "scenario"), "plugin": s.get("plugin", ""),
            "min_interval_min": s.get("min_interval_min"), "jitter_pct": s.get("jitter_pct"),
            "daily_limit": s.get("daily_limit"), "max_photos": s.get("max_photos"), "title_spaces": s.get("title_spaces", 0),
            "confirm_before_publish": s.get("confirm_before_publish", False),
            "currency": s.get("currency", ""), "title_brand": bool(s.get("title_brand", s["id"] in ("vatera", "njukalo", "njuskalo"))),
            "no_browser": bool(s.get("no_browser")),
            "scenarios": {k: len(v) for k, v in sc.items()},
            "has_publish": {k: any(st["action"] == "publish" for st in v) for k, v in sc.items()},
            "status": engine.site_status.get(s["id"], "—"),
            "today": engine.today_count(s["id"]),
        }

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return (WEB / "index.html").read_text("utf-8")

    @app.get("/api/state")
    async def state(history: int = 0):
        prods = list(engine.state["products"].values())
        active = [p for p in prods if p["status"] != "archived"]
        archived = sorted([p for p in prods if p["status"] == "archived"], key=lambda p: p.get("archived_at", ""), reverse=True)
        active.sort(key=lambda p: p["added"])
        return {
            "paused": engine.paused,
            "version": getattr(engine, "version", "?"),
            "browser": engine.cfg.get("browser_channel") or "встроенный",
            "recording": engine.recording and {"site": engine.recording["site"], "line": engine.recording["line"]},
            "pinned": engine.browser.pinned,
            "work_hours_now": engine.in_work_hours(),
            "work_hours": engine.cfg.get("work_hours", [0, 24]),
            "sites": [site_view(s) for s in C.load_sites()],
            "lines": engine.cfg["lines"],
            "photo_qc": engine.cfg.get("photo_qc") or "normal",
            "products": active + archived[: (200 if history else 20)],
            "counter": engine.cfg.get("code_counter"),
            "logs": list(engine.logs)[-150:],
            "queue_root": engine.cfg["queue_root"],
            "telegram_ok": bool(engine.cfg["telegram"].get("token") and engine.cfg["telegram"].get("chat_id")),
        }

    @app.get("/favicon.ico")
    async def favicon():
        return FileResponse(WEB / "icon.ico", media_type="image/x-icon")

    @app.get("/icon.png")
    async def icon_png():
        return FileResponse(WEB / "icon.png", media_type="image/png")

    @app.get("/logo.png")
    async def logo_png():
        f = WEB / "store_logo.png"
        if not f.exists():
            raise HTTPException(404)
        return FileResponse(f, media_type="image/png")

    # ---------- Donini Manager внутри программы ----------
    @app.get("/manager", response_class=HTMLResponse)
    async def manager_page():
        f = WEB / "manager.html"
        if not f.exists():
            raise HTTPException(404, "Donini Manager не найден")
        return HTMLResponse(f.read_text("utf-8"), headers={"Cache-Control": "no-store"})

    @app.get("/api/manager/data")
    async def manager_data():
        import json as _json
        f = C.DATA / "manager_overrides.json"
        try:
            ov = _json.loads(f.read_text("utf-8")) if f.exists() else {}
        except Exception:
            ov = {}
        return {"customTypes": engine.cfg.get("custom_templates", []), "overrides": ov}

    # ---------- источники фото: альбомы 微商相册 и свой сайт ----------
    SHOPS = C.DATA / "szwego_shops.json"

    def _shops():
        import json as _json
        try:
            return _json.loads(SHOPS.read_text("utf-8"))
        except Exception:
            return {}

    @app.post("/api/szwego/shop")
    async def szwego_shop(req: Request):
        import json as _json
        import time as _t
        d = await req.json()
        sid = str(d.get("id") or "").strip()
        if not sid:
            return {"ok": False}
        shops = _shops()
        old = shops.get(sid) or {}
        shops[sid] = {"id": sid, "name": old.get("alias") or d.get("name") or old.get("name") or sid, "alias": old.get("alias", ""),
                      "url": d.get("url") or old.get("url"), "tags": d.get("tags") or old.get("tags") or [], "seen": _t.time()}
        SHOPS.write_text(_json.dumps(shops, ensure_ascii=False, indent=1), "utf-8")
        return {"ok": True}

    @app.get("/api/szwego/shops")
    async def szwego_shops():
        return {"shops": sorted(_shops().values(), key=lambda x: -(x.get("seen") or 0))}

    @app.post("/api/szwego/shop/rename")
    async def szwego_rename(req: Request):
        import json as _json
        d = await req.json()
        shops = _shops()
        sh = shops.get(str(d.get("id")))
        if sh is None:
            raise HTTPException(404)
        if d.get("delete"):
            shops.pop(str(d.get("id")))
        else:
            sh["alias"] = sh["name"] = (d.get("name") or "").strip() or sh["name"]
        SHOPS.write_text(_json.dumps(shops, ensure_ascii=False, indent=1), "utf-8")
        return {"ok": True}

    @app.get("/api/woo/lists")
    async def woo_lists():
        try:
            woo = _woo_mod().Woo(engine.cfg)
            return await asyncio.to_thread(woo.lists)
        except Exception as e:
            raise HTTPException(400, f"Сайт не подключён: {e}")

    @app.post("/api/woo/pull")
    async def woo_pull(req: Request):
        from . import sources
        d = await req.json()
        if sources.STATE["running"]:
            return {"ok": False, "error": "Уже скачиваю — подождите"}
        line = next((l for l in engine.cfg["lines"] if l["id"] == d.get("line")), None)
        if not line or line["id"] == "site":
            raise HTTPException(400, "Выберите вид товара для досок")
        try:
            woo = _woo_mod().Woo(engine.cfg)
        except Exception as e:
            raise HTTPException(400, f"Сайт не подключён: {e}")
        import threading
        threading.Thread(target=sources.pull_from_woo, daemon=True,
                         args=(woo, engine.cfg, line, d.get("category") or "", (d.get("search") or "").strip(),
                               max(1, min(1000, int(d.get("limit") or 50))), d.get("only_new", True) is not False, engine.log)).start()
        return {"ok": True}

    # ---------- каталог своего сайта: товары с фото, клик — в очередь ----------
    _cat_cache = {}

    def _brand_attr(woo):
        w = engine.cfg.get("woo") or {}
        aid = w.get("brand_attr")
        if "attrs" not in _cat_cache:
            _cat_cache["attrs"] = woo.wc("products/attributes") or []
        attrs = _cat_cache["attrs"]
        a = next((x for x in attrs if str(x.get("id")) == str(aid)), None) if aid else None
        if not a:
            a = next((x for x in attrs if any(n in (x.get("name") or "").lower() for n in ("marka", "brand", "бренд"))), None)
        return a

    @app.get("/api/woo/brands")
    async def woo_brands():
        try:
            woo = _woo_mod().Woo(engine.cfg)
            def get():
                a = _brand_attr(woo)
                if not a:
                    return []
                terms = woo.wc_all(f"products/attributes/{a['id']}/terms", {"orderby": "name", "hide_empty": "true"})
                return [{"id": t["id"], "name": t["name"], "count": t.get("count", 0)} for t in terms]
            return {"brands": await asyncio.to_thread(get)}
        except Exception as e:
            raise HTTPException(400, f"Сайт не подключён: {e}")

    def _in_queue_woo():
        """Товары сайта, которые СЕЙЧАС лежат в очереди (не «когда-то скачивали»): по папке скачивания и по коду."""
        from . import sources
        queued = [p for p in engine.state["products"].values() if p.get("status") != "archived"]
        folders = {Path(p.get("folder") or "").name for p in queued}
        codes = {str(p.get("code")) for p in queued}
        ids = {wid for wid, folder in sources._seen().items() if folder in folders}
        return ids, codes

    @app.get("/api/woo/catalog_ids")
    async def woo_catalog_ids(category: str = "", brand: str = "", search: str = ""):
        """Все товары сайта по фильтру (категория + бренд + поиск) — для кнопки «Скачать все»."""
        from . import sources
        try:
            woo = _woo_mod().Woo(engine.cfg)
        except Exception as e:
            raise HTTPException(400, f"Сайт не подключён: {e}")

        def get():
            params = {"status": "publish", "orderby": "date", "order": "desc", "per_page": 100, "_fields": "id,images,sku"}
            if category:
                params["category"] = category
            if search:
                params["search"] = search
            if brand:
                a = _brand_attr(woo)
                if a:
                    params["attribute"] = a.get("slug") or f"pa_{a['id']}"
                    params["attribute_term"] = brand
            out = []
            for page in range(1, 31):  # до 3000 товаров
                chunk = woo.wc("products", params={**params, "page": page}) or []
                out += chunk
                if len(chunk) < 100:
                    break
            return out
        try:
            prods = await asyncio.to_thread(get)
        except Exception as e:
            raise HTTPException(400, f"Сайт doninisklep.com сейчас не отвечает — подождите минуту ({str(e)[:80]})")
        inq, codes = _in_queue_woo()
        prods = [p for p in prods if p.get("images")]
        ids = [p["id"] for p in prods]
        new = [p["id"] for p in prods if str(p["id"]) not in inq and str(p.get("sku") or "-") not in codes]
        return {"total": len(ids), "ids": ids, "new": new}

    @app.get("/api/woo/catalog")
    async def woo_catalog(category: str = "", brand: str = "", search: str = "", page: int = 1):
        from . import sources
        try:
            woo = _woo_mod().Woo(engine.cfg)
        except Exception as e:
            raise HTTPException(400, f"Сайт не подключён: {e}")
        w = engine.cfg.get("woo") or {}

        def get():
            params = {"status": "publish", "orderby": "date", "order": "desc", "per_page": 40, "page": max(1, page),
                      "_fields": "id,name,images,attributes,dimensions,price,regular_price,sku,permalink"}
            if category:
                params["category"] = category
            if search:
                params["search"] = search
            if brand:
                a = _brand_attr(woo)
                if a:
                    params["attribute"] = a.get("slug") or f"pa_{a['id']}"
                    params["attribute_term"] = brand
            return woo.wc("products", params=params) or []
        try:
            prods = await asyncio.to_thread(get)
        except Exception as e:
            raise HTTPException(400, f"Сайт doninisklep.com сейчас не отвечает — подождите минуту и обновите ({str(e)[:80]})")
        inq, in_queue = _in_queue_woo()  # что СЕЙЧАС лежит в очереди (по папке скачивания и по коду = артикулу)
        out = []
        for p in prods:
            b, size = sources.product_info(p, w)
            imgs = p.get("images") or []
            out.append({"id": p["id"], "name": p.get("name"), "brand": b, "size": size, "sku": p.get("sku") or "",
                        "price": p.get("regular_price") or p.get("price") or "", "photos": len(imgs),
                        "img": imgs[0].get("src") if imgs else "", "url": p.get("permalink"),
                        "pulled": str(p["id"]) in inq or str(p.get("sku") or "-") in in_queue,
                        "in_queue": str(p["id"]) in inq or str(p.get("sku") or "-") in in_queue})
        return {"products": out, "more": len(prods) >= 40}

    # категория товара на сайте → вид товара в программе (с нужным шаблоном текста); нет такого — создаём
    AUTO_KINDS = [
        (r"чехл|etui|\bcase|obudow", "phonecases", "Чехлы"),
        (r"кеп|czapk\w* z daszk|daszk|\bcap", "caps", "Кепки"),
        (r"галст|krawat|\btie", "ties", "Галстуки"),
        (r"кошел|portfel|portmon|wallet", "wallets", "Кошельки"),
        (r"рем[ен]|pas(ek|ki)\b|belt", "belts", "Ремни"),
        (r"пухов|куртк|kurtk|puch|jacket", "downjackets", "Пуховики"),
        (r"шарф|платок|szal|apaszk|scarf", "scarves", "Шарфы"),
        (r"шапк|czapk|beanie|hat\b", "hats", "Шапки"),
        (r"обув|buty|but\b|sneak|shoe", "shoes", "Обувь"),
        (r"купальн|strój|kostium|swim", "swimsuits", "Купальники"),
        (r"спорт.*сумк|torb\w* sport|sport", "sportbags", "Спортивные сумки"),
        (r"сумк|рюкзак|torb|torebk|plecak|bag", "bags", "Сумки"),
    ]
    import threading as _th
    _auto_lock = _th.Lock()

    def _auto_line(p):
        import re as _re
        text = " ".join(f"{c.get('name', '')} {c.get('slug', '')}" for c in p.get("categories") or []).lower()
        tpl = name = None
        for pat, t, nm in AUTO_KINDS:
            if _re.search(pat, text):
                tpl, name = t, nm
                break
        if not tpl:  # по категории не понять — по названию товара
            nm_text = (p.get("name") or "").lower()
            for pat, t, nm in AUTO_KINDS:
                if _re.search(pat, nm_text):
                    tpl, name = t, nm
                    break
        with _auto_lock:
            lines = [l for l in engine.cfg["lines"] if l["id"] != "site"]
            if not tpl:
                return lines[0]
            for l in lines:
                if l.get("template") == tpl or l["name"].strip().lower() == name.lower():
                    return l
            base = next((l for l in lines if l["name"].lower().startswith("сумк")), lines[0] if lines else {"sites": []})
            new = {"id": f"auto_{tpl}", "name": name, "folder": name, "template": tpl, "default_size": "",
                   "default_price": 0, "sites": list(base.get("sites") or []), "counter": 0}
            cfg = C.load_config()
            cfg["lines"].append(new)
            C.save_config(cfg)
            engine.cfg = C.load_config()
            engine.log(f"🆕 Создан вид товара «{name}» (шаблон текста: {name}, сайты как у «{base.get('name', '')}»). "
                       f"Проверьте сайты в «Виды товара» и запишите сценарии с нужной категорией")
            return next(l for l in engine.cfg["lines"] if l["id"] == new["id"])

    @app.post("/api/woo/pull_ids")
    async def woo_pull_ids(req: Request):
        from . import sources
        d = await req.json()
        resolve = None
        if d.get("line") == "__auto":
            resolve = _auto_line
            line = next((l for l in engine.cfg["lines"] if l["id"] != "site"), None)
        else:
            line = next((l for l in engine.cfg["lines"] if l["id"] == d.get("line")), None)
        if not line or line["id"] == "site":
            raise HTTPException(400, "Выберите вид товара для досок")
        ids = [int(x) for x in d.get("ids") or [] if str(x).isdigit()][:500]
        if not ids:
            return {"ok": False, "error": "Ничего не выбрано"}
        woo = _woo_mod().Woo(engine.cfg)
        import threading
        threading.Thread(target=sources.pull_ids, args=(woo, engine.cfg, line, ids, engine.log, resolve), daemon=True).start()
        return {"ok": True}

    @app.get("/api/woo/pull/status")
    async def woo_pull_status():
        from . import sources
        return {k: v for k, v in sources.STATE.items() if k != "stop"}

    @app.post("/api/woo/pull/stop")
    async def woo_pull_stop():
        from . import sources
        sources.STATE["stop"] = True
        return {"ok": True}

    # ---------- мост окна программы с расширением Donini в Chrome ----------
    # Окно программы — отдельное приложение, расширение живёт в Chrome. Расширение постоянно спрашивает
    # программу «есть команда?» (/api/bridge/poll), выполняет и присылает результат (/api/bridge/result).
    import itertools
    import time as _time
    bridge = {"q": asyncio.Queue(), "wait": {}, "seen": 0.0, "version": None, "ids": itertools.count(1), "by": {}}

    def _preferred_browser():
        fn = getattr(engine, "pick_browser", None)
        try:
            return fn() if fn else None
        except Exception:
            return None

    @app.get("/api/bridge/poll")
    async def bridge_poll(v: str = "", b: str = ""):
        now = _time.time()
        if b:
            bridge["by"][b] = now
            if engine.cfg.get("_ext_browser") != b and not any(k != b and now - t < 45 for k, t in bridge["by"].items()):
                cfg = C.load_config()
                cfg["_ext_browser"] = b
                C.save_config(cfg)
                engine.cfg = C.load_config()
        bridge["seen"] = now
        bridge["version"] = v or bridge["version"]
        # программа обновилась, а расширение в браузере ещё старое — просим его перезагрузиться само
        try:
            import json as _json
            disk = _json.loads((C.ROOT / "extension" / "manifest.json").read_text("utf-8")).get("version", "")
            vt = lambda x: tuple(int(n) for n in str(x).split(".") if n.isdigit())
            if v and disk and vt(disk) > vt(v) and now - bridge.get("reload_at", 0) > 600:
                bridge["reload_at"] = now
                engine.log(f"🧩 Обновляю расширение в браузере: {v} → {disk}")
                return {"cmd": None, "reload": True}
        except Exception:
            pass
        end = _time.time() + 20
        while _time.time() < end:
            try:
                cmd = await asyncio.wait_for(bridge["q"].get(), timeout=max(0.1, end - _time.time()))
            except asyncio.TimeoutError:
                break
            fut = bridge["wait"].get(cmd["id"])
            if fut and not fut.done():
                bridge["seen"] = _time.time()
                return {"cmd": cmd}
        bridge["seen"] = _time.time()
        return {"cmd": None}

    @app.post("/api/bridge/result")
    async def bridge_result(req: Request):
        data = await req.json()
        fut = bridge["wait"].get(data.get("id"))
        if fut and not fut.done():
            fut.set_result(data.get("result"))
        return {"ok": True}

    def bridge_online():
        return _time.time() - bridge["seen"] < 45

    @app.get("/api/bridge/status")
    async def bridge_status():
        return {"online": bridge_online(), "version": bridge["version"]}

    @app.post("/api/bridge/cmd")
    async def bridge_cmd(req: Request):
        data = await req.json()
        msg = data.get("msg") or {}
        if not bridge_online():
            return {"ok": False, "offline": True, "error": "Расширение Donini в Chrome не отвечает"}
        cid = next(bridge["ids"])
        fut = asyncio.get_event_loop().create_future()
        bridge["wait"][cid] = fut
        await bridge["q"].put({"id": cid, "msg": msg})
        try:
            res = await asyncio.wait_for(fut, timeout=float(data.get("timeout") or 20))
            return {"ok": True, "result": res}
        except asyncio.TimeoutError:
            return {"ok": False, "error": "Расширение не ответило вовремя"}
        finally:
            bridge["wait"].pop(cid, None)

    # ---------- товары перетаскиванием в окно программы (без проводника) ----------
    uploads = {}
    UP_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".gif", ".zip", ".txt"}

    def _line_dir(line_id):
        cfg = engine.cfg
        line = next((l for l in cfg["lines"] if l["id"] == line_id), None)
        if not line:
            raise HTTPException(404, "Нет такого вида товара")
        return Path(cfg["queue_root"]) / line["folder"]

    def _safe_rel(rel):
        parts = [x for x in str(rel).replace("\\", "/").split("/") if x not in ("", ".", "..")]
        parts = ["".join(ch for ch in x if ch not in '<>:"|?*').strip() for x in parts]
        parts = [x for x in parts if x]
        if not parts:
            raise HTTPException(400, "Плохое имя файла")
        return Path(*parts)

    @app.post("/api/upload/begin")
    async def upload_begin(req: Request):
        data = await req.json()
        d = _line_dir(data.get("line"))
        import uuid
        tok = uuid.uuid4().hex[:12]
        tmp = d / f"_загрузка_{tok}"
        tmp.mkdir(parents=True, exist_ok=True)
        uploads[tok] = {"line": data.get("line"), "dir": d, "tmp": tmp}
        return {"ok": True, "token": tok}

    @app.post("/api/upload/file")
    async def upload_file(token: str, rel: str, req: Request):
        u = uploads.get(token)
        if not u:
            raise HTTPException(404, "Загрузка не найдена")
        r = _safe_rel(rel)
        if r.suffix.lower() not in UP_EXT:
            return {"ok": True, "skipped": True}
        dst = u["tmp"] / r
        dst.parent.mkdir(parents=True, exist_ok=True)
        body = await req.body()
        await asyncio.get_event_loop().run_in_executor(None, dst.write_bytes, body)
        return {"ok": True}

    @app.post("/api/upload/end")
    async def upload_end(req: Request):
        import shutil
        data = await req.json()
        u = uploads.pop(data.get("token"), None)
        if not u:
            raise HTTPException(404, "Загрузка не найдена")
        tmp, dest = u["tmp"], u["dir"]
        imgs = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".gif"}

        def has_imgs(p):
            return any(f.is_file() and f.suffix.lower() in imgs for f in p.iterdir())

        def unique(p):
            if not p.exists():
                return p
            i = 2
            while True:
                q = p.with_name(f"{p.name} ({i})")
                if not q.exists():
                    return q
                i += 1

        def finish():
            folders = loose = 0
            # перетащили папку-сборник (например «рюкзаки» со 100 товарами внутри) — берём товары из неё
            items = []
            for e in sorted(tmp.iterdir()):
                if e.is_dir() and not has_imgs(e) and any(x.is_dir() for x in e.iterdir()):
                    items += sorted(x for x in e.iterdir())
                else:
                    items.append(e)
            for e in items:
                if e.is_dir():
                    shutil.move(str(e), str(unique(dest / e.name)))
                    folders += 1
                elif e.is_file():
                    shutil.move(str(e), str(unique(dest / e.name)))
                    loose += 1
            shutil.rmtree(tmp, ignore_errors=True)
            return folders, loose
        folders, loose = await asyncio.get_event_loop().run_in_executor(None, finish)
        line = next((l for l in engine.cfg["lines"] if l["id"] == u["line"]), {})
        engine.log(f"📥 Добавлено перетаскиванием в «{line.get('name', u['line'])}»: товаров {folders}"
                   + (f", отдельных файлов {loose}" if loose else ""))
        return {"ok": True, "folders": folders, "files": loose}

    # автозапуск вместе с Windows (ярлык в папке «Автозагрузка»)
    @app.get("/api/app/autostart")
    async def autostart_get():
        fn = getattr(engine, "autostart_state", None)
        return {"on": bool(fn and await asyncio.get_event_loop().run_in_executor(None, fn)), "available": bool(fn)}

    @app.post("/api/app/autostart")
    async def autostart_set(req: Request):
        data = await req.json()
        fn = getattr(engine, "set_autostart", None)
        if not fn:
            return {"ok": False, "error": "Автозапуск доступен только в Windows"}
        on = bool(data.get("on"))
        cfg = C.load_config()
        cfg["autostart"] = on
        C.save_config(cfg)
        engine.cfg = C.load_config()
        await asyncio.get_event_loop().run_in_executor(None, lambda: fn(on))
        engine.log("🚀 Автозапуск с Windows включён" if on else "Автозапуск с Windows выключен")
        return {"ok": True, "on": on}

    @app.get("/api/app/browser")
    async def app_browser():
        info = getattr(engine, "browser_info", None)
        d = await asyncio.to_thread(info) if info else {"installed": [], "names": {}}
        now = _time.time()
        d["ext_seen"] = sorted({k for k, t in list(bridge["by"].items()) + list(_ext_seen.items()) if now - t < 600})
        d["bridge_online"] = bridge_online()
        d["choice"] = engine.cfg.get("user_browser") or "auto"
        return d

    # восстановление из резервной копии: файлы кладём в data/_restore, программа перезапускается и подхватывает их
    @app.post("/api/app/restore")
    async def app_restore(req: Request):
        import io
        import zipfile
        body = await req.body()
        try:
            z = zipfile.ZipFile(io.BytesIO(body))
        except Exception:
            raise HTTPException(400, "Это не архив резервной копии (.zip)")
        names = [n for n in z.namelist() if "/data/" in n.replace("\\", "/") and not n.endswith("/")]
        if not any(n.endswith("data/config.json") for n in names):
            raise HTTPException(400, "В архиве нет настроек — нужен архив «DoniniPoster резервная копия …zip»")
        dst = C.DATA / "_restore"
        import shutil
        shutil.rmtree(dst, ignore_errors=True)
        n = 0
        for name in names:
            rel = name.replace("\\", "/").split("/data/", 1)[1]
            if not rel or ".." in rel or rel in ("log.txt", "window_log.txt"):
                continue
            t = dst / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(z.read(name))
            n += 1
        engine.log(f"♻️ Восстановление из резервной копии: файлов {n} — перезапускаю программу")
        fn = getattr(engine, "restart_self", None)
        if fn:
            asyncio.get_event_loop().call_later(1.0, fn)
        return {"ok": True, "files": n}

    # ---------- обновления программы (GitHub) ----------
    @app.get("/api/update/status")
    async def update_status(force: int = 0):
        from . import updater
        info = getattr(engine, "update_info", None)
        if force or not info:
            info = await asyncio.to_thread(updater.check, engine.cfg)
            engine.update_info = info
        return {**info, "repo_cfg": engine.cfg.get("update_repo") or "", "source": updater.source(engine.cfg)}

    @app.post("/api/update/source")
    async def update_source(req: Request):
        d = await req.json()
        cfg = C.load_config()
        cfg["update_repo"] = (d.get("repo") or "").strip()
        C.save_config(cfg)
        engine.cfg = C.load_config()
        engine.update_info = None
        return {"ok": True}

    @app.post("/api/update/install")
    async def update_install():
        from . import updater
        info = await asyncio.to_thread(updater.check, engine.cfg)
        if not info.get("available"):
            return {"ok": False, "error": info.get("error") or "У вас последняя версия"}
        try:
            await asyncio.to_thread(updater.download, info, engine.log)
        except Exception as e:
            raise HTTPException(400, f"Не получилось скачать обновление: {e}")
        fn = getattr(engine, "restart_self", None)
        if fn:
            asyncio.get_event_loop().call_later(1.0, fn)
        return {"ok": True, "version": info["latest"]}

    @app.get("/api/ext/diag")
    async def ext_diag():
        """Почему окно программы не видит расширение: какие копии расширения стучатся и отвечают ли они."""
        import time as _t
        now = _t.time()
        names = {"yandex": "Яндекс Браузер", "chrome": "Google Chrome", "edge": "Microsoft Edge", "brave": "Brave",
                 "opera": "Opera", "vivaldi": "Vivaldi"}
        copies = []
        for i, c in _ext_copies.items():
            if now - c.get("last", 0) > 1800:
                continue
            copies.append({"id": i, "browser": names.get(c["browser"], c["browser"]), "ago": int(now - c["last"]),
                           "bridge": bool(c.get("poll") and now - c["poll"] < 60), "version": c.get("version")})
        return {"online": bridge_online(), "copies": copies}

    @app.post("/api/app/browser")
    async def app_browser_set(req: Request):
        d = await req.json()
        cfg = C.load_config()
        cfg["user_browser"] = d.get("choice") or "auto"
        C.save_config(cfg)
        engine.cfg = C.load_config()
        engine.log(f"🌐 Браузер для досок: {cfg['user_browser']}")
        return {"ok": True}

    # копия программы для другого человека: без ваших ключей, очереди, журнала и входов на сайты
    @app.get("/api/app/paths")
    async def app_paths():
        return {"root": str(C.ROOT), "extension": str(C.ROOT / "extension")}

    @app.post("/api/app/export")
    async def app_export(req: Request):
        import zipfile
        from datetime import date as _date
        try:
            full = bool((await req.json()).get("full"))
        except Exception:
            full = False

        def make():
            root = C.ROOT
            desk = Path(os.path.expanduser("~")) / "Desktop"
            if not desk.exists():
                desk = root.parent
            dst = desk / (f"DoniniPoster резервная копия {_date.today():%Y-%m-%d}.zip" if full else "DoniniPoster для передачи.zip")
            skip_dirs = {"__pycache__", "python", "Очередь", "Очередь сайта", "Выставлено", "Скачано WeChat", "_старая_версия", "data"}
            n = 0
            with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
                for p in root.rglob("*"):
                    rel = p.relative_to(root)
                    if not p.is_file() or any(part in skip_dirs for part in rel.parts[:-1]) or rel.parts[0] in skip_dirs:
                        continue
                    if p.name in ("store_icon.done",):
                        continue
                    z.write(p, Path("DoniniPoster") / rel); n += 1
                for p in (root / "data" / "sites").glob("*.json"):  # записанные сценарии сайтов
                    z.write(p, Path("DoniniPoster") / "data" / "sites" / p.name); n += 1
                if full:
                    # резервная копия для себя (переустановка Windows): + настройки, ключи, очередь, шаблоны
                    for p in (root / "data").glob("*"):
                        if p.is_file() and p.name not in ("log.txt", "window_log.txt"):
                            z.write(p, Path("DoniniPoster") / "data" / p.name); n += 1
                    for p in (root / "data" / "sites").glob(".*"):
                        z.write(p, Path("DoniniPoster") / "data" / "sites" / p.name); n += 1
            return str(dst), n
        path, n = await asyncio.to_thread(make)
        engine.log(f"💾 Резервная копия: {path} (файлов {n})" if full else f"📦 Копия программы для передачи: {path} (файлов {n})")
        return {"ok": True, "path": path, "files": n}

    @app.get("/api/version")
    async def version():
        return {"version": getattr(engine, "version", "?")}

    # ---------- применить изменения файлов программы без Запуск.bat ----------
    def _disk_state():
        import hashlib
        h = hashlib.sha1()
        for f in sorted(Path(__file__).parent.glob("*.py")):
            try:
                h.update(f.name.encode()); h.update(f.read_bytes())
            except OSError:
                pass
        try:
            base = (Path(__file__).parent / "VERSION").read_text("utf-8").strip() or "4.2"
        except OSError:
            base = "4.2"
        try:
            web = hashlib.sha1((Path(__file__).parent / "web" / "index.html").read_bytes()).hexdigest()[:8]
        except OSError:
            web = ""
        return f"{base}-{h.hexdigest()[:8]}", web

    @app.get("/api/app/pending")
    async def app_pending():
        disk, web = await asyncio.to_thread(_disk_state)
        run = getattr(engine, "version", "?")
        return {"running": run, "disk": disk, "web": web, "restart": disk != run}

    @app.post("/api/app/restart")
    async def app_restart():
        fn = getattr(engine, "restart_self", None)
        if not fn:
            raise HTTPException(400, "Перезапуск недоступен — запустите программу заново ярлыком")
        engine.log("🔄 Перезапуск программы, чтобы применить изменения…")
        asyncio.get_event_loop().call_later(0.7, fn)
        return {"ok": True}

    # браузер пользователя: запущен ли с настройкой фоновой работы (для OLX / Njuškalo в фоновом окне)
    @app.get("/api/browser/status")
    async def browser_status():
        fn = getattr(engine, "browser_status", None)
        if not fn:
            return {"running": False, "ok": True}
        return await asyncio.get_event_loop().run_in_executor(None, fn)

    @app.post("/api/browser/restart")
    async def browser_restart():
        fn = getattr(engine, "restart_browser", None)
        if not fn:
            return {"ok": False, "error": "недоступно"}
        engine.log("🔄 Перезапускаю браузер с настройкой фоновой работы…")
        # отвечаем сразу: страница программы сама закроется вместе с браузером и откроется снова
        asyncio.get_event_loop().call_later(0.8, lambda: asyncio.get_event_loop().run_in_executor(None, fn))
        return {"ok": True}

    @app.get("/api/meta")
    async def meta():
        return {"langs": [{"code": c, "name": LANG_NAMES[c]} for c in ALL_LANGS],
                "types": list_types(engine.cfg.get("custom_templates", []))}

    @app.get("/api/config")
    async def get_config():
        cfg = dict(engine.cfg)
        return cfg

    @app.post("/api/config")
    async def set_config(req: Request):
        data = await req.json()
        cfg = C.load_config()
        # счётчик меняем, только если вы его правда изменили (иначе не откатываем выданные коды)
        if "code_counter" in data and data.get("code_counter_was") == data["code_counter"]:
            data.pop("code_counter")
        for k in ("code_counter", "shared_counter", "queue_root", "done_root", "delete_done_after_days",
                  "work_hours", "rates", "photo_max_side", "telegram", "browser_channel", "proxy", "lines", "photo_qc"):
            if k in data:
                cfg[k] = data[k]
        old_channel = (engine.cfg.get("browser_channel"), engine.cfg.get("proxy", ""))
        C.save_config(cfg)
        engine.cfg = C.load_config()
        engine.log("Настройки сохранены")
        engine.browser.proxy = engine.cfg.get("proxy", "")
        if (engine.cfg.get("browser_channel"), engine.cfg.get("proxy", "")) != old_channel:
            # браузер поменяли — закрываем старый, при следующем действии откроется новый
            await engine.browser.close()
            engine.pages = {}
            engine.log("Браузер изменён. Зайдите заново на сайты кнопкой «Войти» — у нового браузера свои входы.")
        return {"ok": True}

    @app.post("/api/pause")
    async def pause(req: Request):
        data = await req.json()
        engine.set_paused(bool(data.get("paused")))
        if not engine.paused:
            # Старт: сворачиваем окно браузера (если оно было открыто для записи/теста) и начинаем
            await engine.browser.hide_all()
            engine.ensure_workers()
            if not engine.in_work_hours():
                a, b = engine.cfg.get("work_hours", [0, 24])
                engine.log(f"⏰ Сейчас вне рабочих часов ({a}:00–{b}:00) — выставление начнётся в {a}:00. Изменить: Настройки → «Выставлять с/до».")
        return {"ok": True}

    # ---------- сайты ----------
    @app.get("/api/site/{site_id}")
    async def get_site(site_id: str):
        s = C.get_site(site_id)
        if not s:
            raise HTTPException(404)
        return s

    @app.post("/api/site/{site_id}")
    async def save_site(site_id: str, req: Request):
        data = await req.json()
        s = C.get_site(site_id)
        if not s:
            raise HTTPException(404)
        for k in ("name", "lang", "start_url", "enabled", "type", "plugin", "min_interval_min", "jitter_pct",
                  "daily_limit", "max_photos", "confirm_before_publish", "scenarios", "title_spaces", "title_brand", "currency"):
            if k in data:
                s[k] = data[k]
        C.save_site(s)
        engine.ensure_workers()
        return {"ok": True}

    @app.post("/api/site_new")
    async def new_site(req: Request):
        data = await req.json()
        name = (data.get("name") or "").strip()
        url = (data.get("start_url") or "").strip()
        if not name or not url:
            raise HTTPException(400, "Нужно название и адрес сайта")
        if not url.startswith("http"):
            url = "https://" + url
        sid = C.slug(name)
        base, i = sid, 2
        while C.get_site(sid):
            sid = f"{base}_{i}"
            i += 1
        s = {**C.SITE_DEFAULTS, "id": sid, "name": name, "lang": data.get("lang", "PL"), "start_url": url,
             "scenarios": {}, "type": data.get("type") or "ext"}
        C.save_site(s)
        engine.log(f"Добавлен сайт {name}")
        return {"ok": True, "id": sid}

    @app.delete("/api/site/{site_id}")
    async def del_site(site_id: str):
        C.delete_site(site_id)
        t = engine.workers.pop(site_id, None)
        if t:
            t.cancel()
        return {"ok": True}

    @app.post("/api/site/{site_id}/record")
    async def record(site_id: str, req: Request):
        data = await req.json()

        async def run():
            try:
                await engine.start_recording(site_id, data.get("line") or "default")
            except Exception as e:
                engine.recording = None
                engine.browser.pinned = False
                engine.log(f"🎥 Не удалось начать запись: {e.__class__.__name__}: {e}")
        asyncio.create_task(run())
        return {"ok": True}

    @app.post("/api/site/{site_id}/test")
    async def test(site_id: str, req: Request):
        data = await req.json()
        asyncio.create_task(engine.test_site(site_id, data.get("line") or "default"))
        return {"ok": True}

    @app.post("/api/site/{site_id}/open")
    async def open_site(site_id: str):
        asyncio.create_task(engine.open_site(site_id))
        return {"ok": True}

    @app.post("/api/browser/open")
    async def open_browser():
        asyncio.create_task(engine.open_browser())
        return {"ok": True}

    @app.post("/api/browser/hide")
    async def hide_browser():
        await engine.browser.hide_all()
        return {"ok": True}

    # ---------- товары ----------
    def prod(pid):
        p = engine.state["products"].get(pid)
        if not p:
            raise HTTPException(404)
        return p

    @app.post("/api/product/{pid}")
    async def edit_product(pid: str, req: Request):
        p = prod(pid)
        data = await req.json()
        for k in ("size", "code", "brand"):
            if k in data and data[k] is not None:
                p[k] = str(data[k]).strip()
        if "template" in data:  # свой шаблон текста для товара; пусто — как у вида товара
            _set_tpl(p, data.get("template"))
        if "no_brand" in data:
            if data["no_brand"]:
                p["no_brand"] = True
            else:
                p.pop("no_brand", None)
        if "price" in data:
            try:
                p["price"] = float(str(data["price"]).replace(",", "."))
            except ValueError:
                pass
            _price_ok(p)
        if data.get("line") and data["line"] != p.get("line"):
            from .queue_store import set_line
            ln = next((l for l in engine.cfg["lines"] if l["id"] == data["line"]), None)
            if not ln:
                raise HTTPException(400, "Нет такого вида товара")
            set_line(p, ln)
            engine.log(f"➡ Товар {p.get('code')} перенесён в «{ln['name']}»")
        if isinstance(data.get("photos"), list):
            # порядок и выбор фото из карточки товара (первое — главное)
            allowed = set(p.get("photos") or []) | set(_card_photos(p))
            sel = [x for x in data["photos"] if x in allowed]
            if sel:
                p["photos"] = sel
                p["photos_locked"] = True
                p["photos_manual"] = True  # проверено вручную — автопроверка этот товар больше не трогает
                p.pop("qc_allbad", None)
                for st in (p.get("sites") or {}).values():
                    if st.get("status") == "error" and st.get("error") == ALL_BAD:
                        st.update(status="pending", error=None)
                if p.get("qc_bad"):  # вернули фото, убранное проверкой, — больше не считаем его плохим
                    p["qc_bad"] = {k: v for k, v in p["qc_bad"].items() if k not in sel}
                shutil.rmtree(C.PREPARED_DIR / pid, ignore_errors=True)
        if data.get("photos_reset"):
            p.pop("photos_locked", None)
            p.pop("photos_manual", None)
            p["photos"] = _card_photos(p) or p.get("photos") or []
        if "skip_sites" in data:  # галочки сайтов в карточке: снятый сайт — «пропуск» для этого товара
            for sid, on in (data.get("skip_sites") or {}).items():
                st = p.get("sites", {}).get(sid)
                if not st or st.get("status") == "done":
                    continue
                if not on and st.get("status") != "skipped":
                    st["status"] = "skipped"
                elif on and st.get("status") == "skipped":
                    st["status"] = "pending"
        engine.save()
        return {"ok": True}

    def _price_ok(p):
        if float(p.get("price") or 0) > 0:
            for st in (p.get("sites") or {}).values():
                if st.get("status") == "error" and st.get("error") == NO_PRICE:
                    st.update(status="pending", error=None)

    def _set_tpl(p, tpl):
        from .templates import list_types
        tpl = (tpl or "").strip()
        line = next((l for l in engine.cfg["lines"] if l["id"] == p.get("line")), {})
        if not tpl or tpl == line.get("template"):
            p.pop("template", None)
            return
        if tpl not in {t["id"] for t in list_types(engine.cfg.get("custom_templates", []))}:
            raise HTTPException(400, "Нет такого шаблона — откройте Donini Manager, он сохранит шаблоны в программу")
        p["template"] = tpl

    def _card_photos(p):
        from .queue_store import list_photos
        f = Path(p.get("folder") or "")
        if f.is_dir():
            return list_photos(f)
        return [x for x in p.get("kept") or [] if Path(x).exists()]

    @app.get("/api/photo")
    async def photo_full(path: str):
        """Фото товара в полном размере (просмотр в карточке товара)."""
        f = Path(path)
        if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif") or not f.is_file():
            raise HTTPException(404)
        mt = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}.get(f.suffix.lower(), "image/jpeg")
        return FileResponse(f, media_type=mt, headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/product/{pid}/card")
    async def product_card(pid: str):
        """Карточка товара: все фото (выбранные — по порядку), бренд, вид товара и его шаблон, сайты."""
        from .brands import brand_of_product
        from .templates import list_types
        p = prod(pid)
        allp = _card_photos(p)
        sel = [x for x in p.get("photos") or [] if Path(x).exists()] if p.get("photos_locked") else allp
        rest = [x for x in allp if x not in sel]
        line = next((l for l in engine.cfg["lines"] if l["id"] == p.get("line")), {})
        types = {t["id"]: t["label"] for t in list_types(engine.cfg.get("custom_templates", []))}
        names = {s["id"]: s["name"] for s in C.load_sites()}
        return {"id": p["id"], "code": p.get("code"), "name": p.get("name"), "size": p.get("size", ""), "price": p.get("price"),
                "brand": brand_of_product(p), "brand_manual": bool((p.get("brand") or "").strip()), "no_brand": bool(p.get("no_brand")),
                "line": p.get("line"), "line_name": line.get("name", ""), "template": p.get("template") or line.get("template", ""),
                "template_own": p.get("template") or "", "line_template": line.get("template", ""),
                "template_label": types.get(p.get("template") or line.get("template", ""), line.get("template", "")),
                "types": [{"id": k, "label": v} for k, v in types.items()],
                "lines": [{"id": l["id"], "name": l["name"], "template": l.get("template", ""), "template_label": types.get(l.get("template", ""), "")}
                          for l in engine.cfg["lines"] if (l["id"] == "site") == (p.get("line") == "site")],
                "photos": sel, "others": rest, "locked": bool(p.get("photos_locked")), "qc_bad": p.get("qc_bad") or {},
                "folder": p.get("folder"), "folder_exists": Path(p.get("folder") or "").is_dir(), "status": p.get("status"),
                "sites": [{"id": k, "name": names.get(k, k), **v} for k, v in (p.get("sites") or {}).items()]}

    # ---------- действия с несколькими товарами (галочки в очереди) ----------
    @app.post("/api/products/bulk")
    async def products_bulk(req: Request):
        from .queue_store import set_line
        d = await req.json()
        ids = [i for i in d.get("ids") or [] if i in engine.state["products"]]
        act, val = d.get("action"), d.get("value")
        n = 0
        if act == "remove":
            for i in ids:
                try:
                    await remove_product(i); n += 1
                except HTTPException:
                    pass
            return {"ok": True, "done": n}
        for i in ids:
            p = engine.state["products"][i]
            if act == "retry":
                for st in p["sites"].values():
                    if st.get("status") == "error":
                        st.update(status="pending", error=None)
            elif act == "line":
                ln = next((l for l in engine.cfg["lines"] if l["id"] == val), None)
                if not ln:
                    raise HTTPException(400, "Нет такого вида товара")
                set_line(p, ln)
            elif act == "price":
                try:
                    p["price"] = float(str(val).replace(",", "."))
                except ValueError:
                    raise HTTPException(400, "Цена — число")
                _price_ok(p)
            elif act == "size":
                p["size"] = str(val or "").strip()
            elif act == "template":
                _set_tpl(p, val)
            elif act == "texts_reset":  # свой текст убрать — снова по шаблону (Donini Manager)
                p.pop("texts", None)
            elif act == "brand_on":
                p.pop("no_brand", None)
            elif act == "brand_off":
                p["no_brand"] = True
            elif act == "top":  # выставить первыми
                p["added"] = f"2000-01-01T00:00:{n:02d}"
            else:
                raise HTTPException(400, "Неизвестное действие")
            n += 1
        engine.save()
        engine.log(f"✔ Выбранные товары ({n}): {({'retry': 'повтор ошибок', 'line': 'перенесены в другой вид', 'price': 'новая цена', 'size': 'новый размер', 'top': 'выставляются первыми', 'template': 'новый шаблон текста', 'texts_reset': 'тексты снова по шаблону', 'brand_on': 'с брендом', 'brand_off': 'без бренда'}).get(act, act)}")
        return {"ok": True, "done": n}

    # ---------- свой текст товара (перед выгрузкой) ----------
    # ---------- поиск товара по коду / названию по всей программе ----------
    @app.get("/api/search")
    async def search(q: str = ""):
        q = q.strip().lower()
        if len(q) < 2:
            return {"items": []}
        names = {s["id"]: s["name"] for s in C.load_sites()}
        lines = {l["id"]: l["name"] for l in engine.cfg["lines"]}
        hits = []
        for p in engine.state["products"].values():
            code = str(p.get("code") or "")
            hay = f"{code} {p.get('name', '')}".lower()
            if q not in hay:
                continue
            exact = code.lower() == q
            photos = [x for x in (p.get("photos") or []) if Path(x).exists()] or \
                     [x for x in (p.get("kept") or []) if Path(x).exists()]
            sites = [{"id": sid, "name": names.get(sid, sid), "status": st.get("status"), "url": st.get("url"),
                      "error": st.get("error"), "at": st.get("at")} for sid, st in (p.get("sites") or {}).items()]
            hits.append({"id": p["id"], "code": code, "name": p.get("name"), "line": lines.get(p.get("line"), p.get("line")),
                         "size": p.get("size"), "price": p.get("price"), "status": p.get("status"),
                         "added": p.get("added"), "archived_at": p.get("archived_at"), "folder": p.get("folder"),
                         "folder_exists": Path(p.get("folder") or "").is_dir(), "photos": photos[:8], "n_photos": len(photos),
                         "sites": sites, "_exact": exact})
        hits.sort(key=lambda h: (not h["_exact"], h["added"] or ""), reverse=False)
        exact_first = [h for h in hits if h["_exact"]] + sorted([h for h in hits if not h["_exact"]], key=lambda h: h["added"] or "", reverse=True)
        return {"items": exact_first[:30], "total": len(hits)}

    @app.post("/api/line/{lid}/template")
    async def line_template(lid: str, req: Request):
        from .templates import list_types
        tpl = ((await req.json()).get("template") or "").strip()
        if tpl not in {t["id"] for t in list_types(engine.cfg.get("custom_templates", []))}:
            raise HTTPException(400, "Нет такого шаблона")
        cfg = C.load_config()
        ln = next((l for l in cfg["lines"] if l["id"] == lid), None)
        if not ln:
            raise HTTPException(404, "Нет такого вида товара")
        ln["template"] = tpl
        C.save_config(cfg)
        engine.cfg = C.load_config()
        engine.log(f"🧾 «{ln['name']}»: шаблон текста — {tpl}")
        return {"ok": True}

    @app.post("/api/queue/qc_recheck")
    async def qc_recheck(req: Request):
        """«🧹 Проверить фото»: заново проверить фото товаров (выбранных или всех в очереди)."""
        d = await req.json()
        ids = set(d.get("ids") or [])
        n = 0
        for p in engine.state["products"].values():
            if p["status"] == "archived" or (ids and p["id"] not in ids):
                continue
            if (p.get("photos_manual") or (p.get("photos_locked") and not p.get("qc_bad"))) and not ids:
                continue  # фото выбраны вручную — без явного выбора не трогаем
            allp = _card_photos(p)
            if allp:
                p["photos"] = allp
            p.pop("photos_locked", None)
            p.pop("photos_manual", None)
            p.pop("qc_done", None)
            p.pop("qc_bad", None)
            p.pop("qc_allbad", None)
            for st in (p.get("sites") or {}).values():
                if st.get("status") == "error" and st.get("error") == ALL_BAD:
                    st.update(status="pending", error=None)
            shutil.rmtree(C.PREPARED_DIR / p["id"], ignore_errors=True)
            n += 1
        engine.save()
        engine.log(f"🧹 Проверяю фото заново: товаров {n}")
        return {"ok": True, "count": n}

    @app.post("/api/queue/sizes_from_site")
    async def sizes_from_site(req: Request):
        """Товары, скачанные с моего сайта, без размера в очереди: берём размер с сайта заново (описание, «Wymiary», атрибуты)."""
        from . import sources
        d = await req.json()
        ids = set(d.get("ids") or [])
        try:
            woo = _woo_mod().Woo(engine.cfg)
        except Exception as e:
            raise HTTPException(400, f"Сайт не подключён: {e}")
        by_folder = {}
        for wid, folder in sources._seen().items():
            by_folder.setdefault(folder, wid)
        todo = []
        for p in engine.state["products"].values():
            if p["status"] == "archived" or (ids and p["id"] not in ids) or (not ids and (p.get("size") or "").strip()):
                continue
            wid = by_folder.get(Path(p.get("folder") or "").name)
            if wid:
                todo.append((p, wid))
        w = engine.cfg.get("woo") or {}

        def run():
            ok = miss = 0
            for p, wid in todo:
                try:
                    wp = woo.wc(f"products/{int(wid)}")
                    size = sources.product_info(wp, w)[1]
                except Exception as e:
                    engine.log(f"⚠️ Размер с сайта для {p.get('code')}: {e}")
                    miss += 1
                    continue
                if not size:
                    miss += 1
                    continue
                p["size"] = size if "cm" in size.lower() else size + " cm"
                try:  # и в info.txt папки — чтобы размер не потерялся
                    f = Path(p["folder"]) / "info.txt"
                    lines = [x for x in (f.read_text("utf-8").splitlines() if f.exists() else []) if not x.lower().startswith("размер")]
                    f.write_text("\n".join([f"размер: {p['size']}"] + lines) + "\n", "utf-8")
                except OSError:
                    pass
                ok += 1
            return ok, miss
        ok, miss = await asyncio.to_thread(run)
        engine.save()
        engine.log(f"📏 Размер с сайта: подставлен у {ok} товаров" + (f", не найден у {miss}" if miss else ""))
        return {"ok": True, "done": ok, "missing": miss, "candidates": len(todo)}

    @app.post("/api/queue/texts_reset")
    async def queue_texts_reset(req: Request):
        """Кнопка «Тексты по шаблону»: у товаров в очереди убираются свои тексты — всё берётся из шаблона заново."""
        d = await req.json()
        site_mode = d.get("only") == "site"
        line = d.get("line") or ""
        n = 0
        for p in engine.state["products"].values():
            if p["status"] == "archived" or (p.get("line") == "site") != site_mode or (line and p.get("line") != line):
                continue
            if p.pop("texts", None):
                n += 1
        engine.save()
        engine.log(f"🧾 Тексты по шаблону: обновлено товаров с своим текстом — {n}, остальные и так берутся из шаблона")
        return {"ok": True, "reset": n}

    @app.get("/api/product/{pid}/texts")
    async def product_texts(pid: str):
        p = prod(pid)
        line = engine.line(p["line"]) or {}
        own = p.get("texts") or {}
        langs = []
        for sid in p["sites"]:
            s = C.get_site(sid)
            if s and s.get("lang") and s["lang"] not in [x["lang"] for x in langs]:
                langs.append({"lang": s["lang"], "sites": []})
            if s and s.get("lang"):
                next(x for x in langs if x["lang"] == s["lang"])["sites"].append(s["name"])
        out = []
        for x in langs:
            try:
                t, b = build_texts(p.get("template") or line.get("template", "bags"), x["lang"], p.get("size", ""), p["code"],
                                   custom=engine.cfg.get("custom_templates"))
            except Exception as e:
                t, b = "", f"(шаблон не найден: {e})"
            o = own.get(x["lang"]) or {}
            out.append({"lang": x["lang"], "country": LANG_NAMES.get(x["lang"], x["lang"]), "sites": x["sites"],
                        "auto_title": t, "auto_body": b, "title": o.get("title") or t, "body": o.get("body") or b,
                        "edited": bool(o.get("title") or o.get("body"))})
        return {"code": p["code"], "name": p["name"], "langs": out}

    @app.post("/api/product/{pid}/texts")
    async def save_product_texts(pid: str, req: Request):
        p = prod(pid)
        data = await req.json()  # {lang: {title, body}} — пусто/как в шаблоне = вернуть шаблон
        line = engine.line(p["line"]) or {}
        texts = dict(p.get("texts") or {})
        for lang, v in (data or {}).items():
            try:
                t, b = build_texts(p.get("template") or line.get("template", "bags"), lang, p.get("size", ""), p["code"],
                                   custom=engine.cfg.get("custom_templates"))
            except Exception:
                t, b = "", ""
            title = (v.get("title") or "").strip()
            body = (v.get("body") or "").rstrip()
            item = {}
            if title and title != t:
                item["title"] = title
            if body and body != b.rstrip():
                item["body"] = body
            if item:
                texts[lang] = item
            else:
                texts.pop(lang, None)
        p["texts"] = texts
        engine.save()
        engine.log(f"✏️ Товар {p['code']}: свой текст для {', '.join(sorted(texts)) or 'нет (снова по шаблону)'}")
        return {"ok": True, "edited": sorted(texts)}

    @app.post("/api/product/{pid}/retry")
    async def retry(pid: str, req: Request):
        p = prod(pid)
        data = await req.json()
        for sid, st in p["sites"].items():
            if data.get("site") in (None, sid) and st["status"] in ("error", "skipped"):
                st["status"] = "pending"
                st.pop("error", None)
        engine.save()
        return {"ok": True}

    @app.post("/api/product/{pid}/skip")
    async def skip(pid: str, req: Request):
        p = prod(pid)
        data = await req.json()
        for sid, st in p["sites"].items():
            if data.get("site") in (None, sid) and st["status"] in ("pending", "error"):
                st["status"] = "skipped"
        engine.save()
        return {"ok": True}

    @app.post("/api/product/{pid}/mark_done")
    async def mark_done(pid: str, req: Request):
        p = prod(pid)
        data = await req.json()
        st = p["sites"].get(data.get("site"))
        if st:
            st["status"] = "done"
        engine.save()
        return {"ok": True}

    @app.delete("/api/product/{pid}")
    async def remove_product(pid: str):
        # Раньше товар убирался только из списка, а папка оставалась в «Очереди» —
        # через несколько секунд программа находила её снова и товар возвращался.
        # Теперь папка переносится в «_удалено» (как у «Очистить очередь»), и товар больше не появляется.
        import shutil
        p = engine.state["products"].get(pid)
        if p and p.get("status") != "archived" and p.get("folder"):
            src = Path(p["folder"])
            if src.exists():
                trash = src.parent / "_удалено"
                try:
                    trash.mkdir(exist_ok=True)
                    dst = trash / src.name
                    i = 2
                    while dst.exists():
                        dst = trash / f"{src.name} ({i})"
                        i += 1
                    shutil.move(str(src), str(dst))
                except Exception as e:
                    engine.log(f"Не удалось убрать папку {src}: {e}")
                    raise HTTPException(409, f"Не удалось перенести папку товара (возможно, она открыта в другой программе): {e}")
        engine.state["products"].pop(pid, None)
        shutil.rmtree(C.PREPARED_DIR / pid, ignore_errors=True)
        engine.save()
        if p:
            engine.log(f"🗑 Товар {p.get('code', '')} убран из очереди (папка в «_удалено»)")
        return {"ok": True}

    @app.post("/api/queue/clear")
    async def clear_queue(req: Request):
        """Очистить очередь одной кнопкой: все невыставленные товары убираются из очереди,
        их папки переносятся в «_удалено» внутри папки линии (программа такие папки не читает,
        поэтому товары не появятся снова; при необходимости папку можно вернуть руками)."""
        import shutil
        removed, failed = 0, 0
        try:
            only = (await req.json()).get("only")
        except Exception:
            only = None
        for pid, p in list(engine.state["products"].items()):
            if p.get("status") == "archived":
                continue  # уже выставленные (история) не трогаем
            # «Очередь» и «Очередь сайта» чистятся отдельно
            if only == "site" and p.get("line") != "site":
                continue
            if only == "boards" and p.get("line") == "site":
                continue
            src = Path(p.get("folder") or "")
            if p.get("folder") and src.exists():
                trash = src.parent / "_удалено"
                try:
                    trash.mkdir(exist_ok=True)
                    dst = trash / src.name
                    i = 2
                    while dst.exists():
                        dst = trash / f"{src.name} ({i})"
                        i += 1
                    shutil.move(str(src), str(dst))
                except Exception as e:
                    engine.log(f"Не удалось убрать папку {src}: {e}")
                    failed += 1
                    continue
            engine.state["products"].pop(pid, None)
            shutil.rmtree(C.PREPARED_DIR / pid, ignore_errors=True)
            removed += 1
        engine.save()
        engine.log(f"🗑 Очередь очищена: убрано товаров — {removed}" + (f", не удалось — {failed}" if failed else "") +
                   " (папки перенесены в «_удалено»)")
        return {"ok": True, "removed": removed, "failed": failed}

    @app.get("/api/preview")
    async def preview(line: str, lang: str, size: str = "", code: str = "", price: float = 0):
        ln = engine.line(line) or engine.cfg["lines"][0]
        title, body = build_texts(ln["template"], lang, size or ln.get("default_size", ""), code,
                                  custom=engine.cfg.get("custom_templates"))
        conv = convert_price(price, lang, engine.cfg.get("rates"))
        return {"title": title, "body": body, "price": conv[0] if conv else "", "currency": conv[1] if conv else ""}

    # ---------- шаблоны ----------
    @app.post("/api/templates/sync")
    async def sync_templates(req: Request):
        """Автосинхронизация с Donini Manager: расширение присылает шаблоны и правки карточек,
        как только Manager открыт в Chrome или в нём что-то поменяли."""
        import json as _json
        data = await req.json()
        items = [ct for ct in (data.get("customTypes") or [])
                 if isinstance(ct, dict) and ct.get("id") and ct.get("label") and isinstance(ct.get("langs"), dict)]
        cfg = C.load_config()
        before = _json.dumps(cfg.get("custom_templates", []), sort_keys=True, ensure_ascii=False)
        existing = {c["id"]: c for c in cfg.get("custom_templates", [])}
        for ct in items:
            existing[ct["id"]] = {"id": ct["id"], "label": ct["label"], "langs": ct["langs"]}
        cfg["custom_templates"] = list(existing.values())
        changed = _json.dumps(cfg["custom_templates"], sort_keys=True, ensure_ascii=False) != before
        if changed:
            C.save_config(cfg)
            engine.cfg = C.load_config()
        ov = {"titleOverrides": data.get("titleOverrides") or {}, "bodyOverrides": data.get("bodyOverrides") or {}}
        f = C.DATA / "manager_overrides.json"
        old = f.read_text(encoding="utf-8") if f.exists() else ""
        new = _json.dumps(ov, ensure_ascii=False, sort_keys=True)
        if new != old:
            f.write_text(new, encoding="utf-8")
            changed = True
        if changed:
            engine.log(f"🔄 Синхронизировано с Donini Manager: шаблонов {len(items)}, правок названий "
                       f"{len(ov['titleOverrides'])}, описаний {len(ov['bodyOverrides'])}")
            own = sum(1 for p in engine.state["products"].values() if p["status"] != "archived" and p.get("texts"))
            if own:
                engine.log(f"ℹ️ У {own} товаров в очереди свой текст (✏️) — он важнее шаблона. Чтобы взять новый шаблон: «🧾 Тексты по шаблону»")
        return {"ok": True, "changed": changed}

    @app.post("/api/templates/import")
    async def import_templates(req: Request):
        data = await req.json()
        try:
            items = decode_donini_code(data.get("code", ""))
        except Exception as e:
            raise HTTPException(400, f"Не получилось прочитать код: {e}")
        cfg = C.load_config()
        existing = {c["id"]: c for c in cfg.get("custom_templates", [])}
        for ct in items:
            existing[ct["id"]] = ct
        cfg["custom_templates"] = list(existing.values())
        C.save_config(cfg)
        engine.cfg = C.load_config()
        engine.log(f"Импортировано шаблонов из Donini: {len(items)}")
        return {"ok": True, "count": len(items)}

    # ---------- telegram ----------
    def _tg_save(token=None, chat_id=None):
        cfg = C.load_config()
        tg = dict(cfg.get("telegram") or {})
        if token is not None:
            tg["token"] = token
        if chat_id is not None:
            tg["chat_id"] = chat_id
        cfg["telegram"] = tg
        C.save_config(cfg)
        engine.cfg = C.load_config()

    # ---------- свой сайт WooCommerce ----------
    def _woo_mod():
        from .engine import load_plugin
        return load_plugin("woocommerce")

    def _woo_save(data):
        cfg = C.load_config()
        w = dict(cfg.get("woo") or {})
        for k in ("url", "ck", "cs", "wp_user", "wp_pass", "status", "category", "brand_attr", "size_attr", "pause_sec", "template"):
            if k in data and data[k] is not None:
                v = data[k]
                if k in ("ck", "cs", "wp_pass") and isinstance(v, str) and v.startswith("••"):
                    continue  # поле не меняли (показывали скрытым)
                w[k] = v.strip() if isinstance(v, str) else v
        cfg["woo"] = w
        C.save_config(cfg)
        engine.cfg = C.load_config()
        site = C.get_site("doninisklep")
        if site and w.get("pause_sec") not in (None, ""):
            try:
                site["min_interval_min"] = max(0.0, float(w["pause_sec"]) / 60)
                C.save_site(site)
            except ValueError:
                pass
        return w

    @app.get("/api/woo/config")
    async def woo_get():
        w = dict(engine.cfg.get("woo") or {})
        w.pop("_terms", None)
        for k in ("ck", "cs", "wp_pass"):
            if w.get(k):
                w[k] = "••••" + w[k][-4:]
        site = C.get_site("doninisklep") or {}
        st = engine.state.get("products", {})
        left = sum(1 for p in st.values() if p.get("status") != "archived" and (p.get("sites", {}).get("doninisklep") or {}).get("status") == "pending")
        done = sum(1 for p in st.values() if (p.get("sites", {}).get("doninisklep") or {}).get("status") == "done")
        err = sum(1 for p in st.values() if (p.get("sites", {}).get("doninisklep") or {}).get("status") == "error")
        return {"woo": w, "running": bool(site.get("enabled")), "left": left, "done": done, "errors": err,
                "status": engine.site_status.get("doninisklep", "")}

    @app.post("/api/woo/config")
    async def woo_set(req: Request):
        _woo_save(await req.json())
        return {"ok": True}

    @app.post("/api/woo/check")
    async def woo_check(req: Request):
        _woo_save(await req.json())
        try:
            mod = _woo_mod()
            woo = mod.Woo(engine.cfg)
            lists = await asyncio.to_thread(woo.lists)
        except Exception as e:
            raise HTTPException(400, f"Не получилось подключиться: {e}")
        auth_err = await asyncio.to_thread(woo.check_wp_auth)
        if auth_err:
            raise HTTPException(400, f"Ключ WooCommerce работает, но фото загрузить не получится: {auth_err}")
        tpl = (engine.cfg.get("woo") or {}).get("template")
        if tpl:
            try:
                t = await asyncio.to_thread(woo.find_product, tpl)
                lists["template"] = {"id": t.get("id"), "name": t.get("name"), "sku": t.get("sku"), "price": t.get("regular_price"),
                                     "attrs": [f"{a.get('name')}: {', '.join(a.get('options') or [])}" for a in t.get("attributes") or []]}
            except Exception as e:
                raise HTTPException(400, f"Сайт подключён, но товар-образец не найден: {e}")
        engine.log(f"🌐 Сайт подключён: категорий {len(lists['categories'])}, атрибутов {len(lists['attributes'])}")
        return lists

    @app.post("/api/woo/run")
    async def woo_run(req: Request):
        data = await req.json()
        site = C.get_site("doninisklep")
        if not site:
            raise HTTPException(404, "нет сайта doninisklep")
        on = bool(data.get("on"))
        if on:
            w = engine.cfg.get("woo") or {}
            if not (w.get("url") and w.get("ck") and w.get("cs") and w.get("wp_user") and w.get("wp_pass")):
                raise HTTPException(400, "Сначала заполните адрес сайта и ключи и нажмите «Проверить подключение»")
        site["enabled"] = on
        C.save_site(site)
        if on:
            # товары, которые не загрузились раньше (ошибка), пробуем снова
            n = 0
            for p in engine.state.get("products", {}).values():
                st = (p.get("sites") or {}).get("doninisklep")
                if st and st.get("status") == "error":
                    st.update(status="pending", error=None)
                    n += 1
            if n:
                engine.save()
                engine.log(f"🌐 Повторю товары с ошибкой: {n}")
        engine.ensure_workers()
        engine.log("🌐 Загрузка на свой сайт запущена" if on else "🌐 Загрузка на свой сайт остановлена")
        return {"ok": True}

    @app.post("/api/telegram/find")
    async def tg_find(req: Request):
        data = await req.json()
        token = (data.get("token") or "").strip()
        if not token:
            raise HTTPException(400, "Сначала вставьте токен бота")
        try:
            cid = await telegram.find_chat_id(token)
        except Exception as e:
            raise HTTPException(400, f"Не получилось: {e}")
        if not cid:
            raise HTTPException(400, "Бот пока не получил от вас сообщений. Откройте своего бота в Telegram, нажмите «Start» (или напишите /start) и нажмите «Найти chat id» ещё раз.")
        _tg_save(token, cid)  # сразу запоминаем — отдельно сохранять не нужно
        engine.log("📨 Telegram подключён (chat id найден и сохранён)")
        return {"chat_id": cid}

    @app.post("/api/telegram/test")
    async def tg_test(req: Request):
        try:
            data = await req.json()
        except Exception:
            data = {}
        token = (data.get("token") or engine.cfg["telegram"].get("token") or "").strip()
        chat = (data.get("chat_id") or engine.cfg["telegram"].get("chat_id") or "").strip()
        if not token or not chat:
            raise HTTPException(400, "Нужны токен и chat id: вставьте токен и нажмите «Найти chat id»")
        try:
            await asyncio.to_thread(telegram.send_raw, token, chat, "👋 Donini Poster на связи. Уведомления работают.")
        except Exception as e:
            raise HTTPException(400, f"Не отправилось: {e}")
        _tg_save(token, chat)
        return {"ok": True}

    # ---------- файлы ----------
    @app.get("/api/thumb")
    async def thumb(path: str, big: int = 0):
        from fastapi.responses import Response
        p = Path(path)
        if not p.exists():
            engine.log(f"Миниатюра: файл не найден — {path}")
            raise HTTPException(404)
        try:
            data = await asyncio.to_thread(images.thumbnail, p, 900 if big else 160)
        except Exception:
            while images.LAST_ERRORS:
                engine.log("⚠️ " + images.LAST_ERRORS.pop(0))
            raise HTTPException(415, "не удалось открыть фото")
        return Response(data, media_type="image/jpeg")

    @app.get("/api/shot")
    async def shot(path: str):
        p = Path(path).resolve()
        if C.SHOTS_DIR.resolve() not in p.parents or not p.exists():
            raise HTTPException(404)
        return FileResponse(p)

    # ---------- скачивание каталога 微商相册 (szwego.com) из расширения ----------
    @app.post("/api/szwego/item")
    async def szwego_item(req: Request):
        from . import szwego
        d = await req.json()
        ln = engine.line(d.get("line") or "") or engine.cfg["lines"][0]
        return await asyncio.to_thread(szwego.download_item, engine.cfg, ln, d.get("dest") or "downloads",
                                       d.get("shop") or "", d.get("item") or {}, bool(d.get("only_new", True)),
                                       bool(d.get("need_size", True)) and bool(engine.cfg.get("szwego_need_size", False)), engine.log)

    @app.post("/api/szwego/open")
    async def szwego_open(req: Request):
        from . import szwego
        d = await req.json()
        ln = engine.line(d.get("line") or "") or engine.cfg["lines"][0]
        path = szwego.target_dir(engine.cfg, ln, d.get("dest") or "downloads")
        path.mkdir(parents=True, exist_ok=True)
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # noqa
        return {"ok": True, "path": str(path)}

    @app.post("/api/open_folder")
    async def open_folder(req: Request):
        data = await req.json()
        path = data.get("path") or engine.cfg["queue_root"]
        if path == "__EXT__":
            path = str(C.ROOT / "extension")
        Path(path).mkdir(parents=True, exist_ok=True)
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa
        else:
            subprocess.Popen(["xdg-open", path])
        return {"ok": True}

    # ---------- помощник для ручной/полуавтоматической публикации ----------
    @app.get("/api/helper/next")
    async def helper_next(site: str, skip: str = ""):
        s, p = engine.manual_next(site, set(x for x in skip.split(",") if x))
        if not s:
            raise HTTPException(404, f"Сайт {site} не найден в программе")
        left = sum(1 for x in engine.state["products"].values() if x["status"] != "archived"
                   and x["sites"].get(site, {}).get("status") in ("pending", "error"))
        if not p:
            return {"product": None, "left": 0, "site": s["name"]}
        photos = await asyncio.to_thread(images.prepare, p, engine.cfg.get("photo_max_side", 1600), s.get("max_photos") or None)
        ad = engine.build_ad(p, s, photos)
        return {"site": s["name"], "left": left,
                "product": {"id": p["id"], "code": p["code"], "name": p["name"], "size": p.get("size", "")},
                "ad": {"title": ad["title"], "body": ad["body"], "price": ad["price"], "currency": ad["currency"]},
                "photos": [f"/api/helper/photo/{p['id']}/{i}?site={site}" for i in range(len(photos))]}

    @app.get("/api/helper/photo/{pid}/{n}")
    async def helper_photo(pid: str, n: int, site: str):
        p = prod(pid)
        s = C.get_site(site) or {}
        photos = await asyncio.to_thread(images.prepare, p, engine.cfg.get("photo_max_side", 1600), s.get("max_photos") or None)
        if n >= len(photos):
            raise HTTPException(404)
        return FileResponse(photos[n], media_type="image/jpeg")

    @app.post("/api/helper/done")
    async def helper_done(req: Request):
        d = await req.json()
        if not engine.manual_done(d.get("pid"), d.get("site"), d.get("url", "")):
            raise HTTPException(404, "товар не найден")
        return {"ok": True}

    @app.post("/api/helper/skip")
    async def helper_skip(req: Request):
        d = await req.json()
        p = prod(d.get("pid"))
        st = p["sites"].get(d.get("site"))
        if st:
            st["status"] = "skipped"
            engine.save()
        return {"ok": True}

    @app.get("/donini-helper.user.js", response_class=PlainTextResponse)
    async def helper_script():
        js = (WEB / "helper.user.js").read_text("utf-8").replace("__PORT__", str(engine.cfg.get("port", 8765)))
        return PlainTextResponse(js, media_type="text/javascript; charset=utf-8")

    # ---------- расширение Donini в браузере пользователя ----------
    def ext_sites():
        return [s for s in C.load_sites() if s.get("type") in ("ext", "manual") and s.get("enabled")]

    def file_url(path):
        from urllib.parse import quote
        return "/api/ext/file?path=" + quote(str(path))

    def public_ad(ad):
        return {k: ad.get(k, "") for k in ("title", "body", "price", "currency", "size", "code", "brand")}

    @app.get("/api/ext/state")
    async def ext_state():
        sites = ext_sites()
        ids = {s["id"]: s for s in sites}
        all_ids = {s["id"]: s for s in C.load_sites() if s.get("type") in ("ext", "manual")}
        prods, noprice = [], []
        for p in sorted(engine.state["products"].values(), key=lambda x: x["added"]):
            edit_only = p["status"] == "archived"
            if edit_only and (engine.cfg.get("edit_paused") or not any(st.get("edit") for st in p["sites"].values())):
                continue
            for sid, st in p["sites"].items():
                # нет номера объявления — бот не сможет его открыть; не тратим попытки, оставляем на ручное исправление
                if st.get("edit") and sid in all_ids and "{ad_id}" in (all_ids[sid].get("edit_url") or "") and not _ad_id(st):
                    st.pop("edit", None)
                    st["status"] = "done"
                    st["edit_manual"] = True
                    engine.log(f"✏️ {all_ids[sid]['name']}: {p.get('code')} — нет номера объявления, исправьте название вручную на сайте")
                    noprice.append(None)
            pend = [sid for sid, st in p["sites"].items() if st.get("status") in ("pending", "error")
                    and ((st.get("edit") and sid in all_ids and not engine.cfg.get("edit_paused"))  # исправления — и на выключенном сайте
                         or (not st.get("edit") and not edit_only and sid in ids))]
            if not pend:
                continue
            from . import photo_qc
            if not edit_only and photo_qc.pending(p, engine.cfg):  # фото ещё проверяются — через пару секунд
                continue
            if not edit_only and p.get("qc_allbad") and (engine.cfg.get("photo_qc") or "normal") != "off":
                for sid in pend:
                    st = p["sites"][sid]
                    if st.get("error") != ALL_BAD:
                        st.update(status="error", error=ALL_BAD)
                        noprice.append(p.get("code"))
                continue
            if not edit_only and not float(p.get("price") or 0) > 0:
                # без цены доски не дают выставить (OLX прячет доставку) — не открываем, сразу видно, что не так
                for sid in pend:
                    st = p["sites"][sid]
                    if st.get("error") != NO_PRICE:
                        st.update(status="error", error=NO_PRICE)
                        noprice.append(p.get("code"))
                continue
            line = p["line"]
            prods.append({"id": p["id"], "code": p["code"], "name": p["name"], "size": p.get("size", ""), "line": line,
                          "price": p.get("price"), "photos": len(p["photos"]),
                          "thumb": "/api/thumb?path=" + __import__("urllib.parse").parse.quote(p["photos"][0]) if p["photos"] else "",
                          "sites": [{"id": sid, "name": all_ids[sid]["name"], "has_steps": bool(engine.scenario_for(all_ids[sid], line))} for sid in pend],
                          "edit": edit_only})
        # исправления идут вперемешку с очередью (1 товар из очереди, 1 исправление) — очередь не стоит
        q = [x for x in prods if not x.get("edit")]
        e = [x for x in prods if x.get("edit")]
        _at = {p["id"]: min((str(st.get("at") or "") for st in p["sites"].values() if st.get("edit")), default="")
               for p in engine.state["products"].values()}
        e.sort(key=lambda x: _at.get(x["id"], ""))
        # проверка на одном — первой, без ожидания очереди
        first = [x for x in e if any(((engine.state["products"].get(x["id"]) or {}).get("sites", {}).get(si["id"]) or {}).get("edit", {}).get("confirm") for si in x["sites"])]
        e = [x for x in e if x not in first]
        prods = list(first)
        while q or e:
            if q:
                prods.append(q.pop(0))
            if e:
                prods.append(e.pop(0))
        if noprice:
            engine.save()
            noprice = [x for x in noprice if x]
        if noprice:
            codes = sorted(set(noprice))
            engine.log(f"⚠️ Не выставляются (нет цены или все фото недокачанные): {', '.join(codes[:10])}{' …' if len(codes) > 10 else ''} — причина видна у товара в очереди")
        in_lines = {sid for l in engine.cfg["lines"] for sid in l.get("sites", [])}
        missing = [s["name"] for s in sites if s["id"] not in in_lines]
        disabled = [s["name"] for s in C.load_sites() if s.get("type") in ("ext", "manual") and not s.get("enabled")]
        return {"ok": True, "base": f"http://127.0.0.1:{engine.cfg.get('port', 8765)}", "products": prods,
                "missing": missing, "disabled": disabled,
                "lines": [{"id": l["id"], "name": l["name"], "template": l.get("template", ""), "sites": [x for x in l.get("sites", []) if x in ids]} for l in engine.cfg["lines"]],
                "sites": [{"id": s["id"], "name": s["name"], "steps": len((s.get("scenarios") or {}).get("default") or []),
                           "by_line": {k: len(v or []) for k, v in (s.get("scenarios") or {}).items()}} for s in sites]}

    @app.get("/api/ext/job")
    async def ext_job(pid: str, sites: str):
        from .scenario import ensure_publish
        p = prod(pid)
        out = []
        for sid in [x for x in sites.split(",") if x]:
            s = C.get_site(sid)
            if not s or sid not in p["sites"]:
                continue
            ed = (p["sites"].get(sid) or {}).get("edit")
            if ed:
                steps = (s.get("scenarios") or {}).get("__edit") or []
                if not steps:
                    raise HTTPException(400, f"{s['name']}: не записан сценарий исправления (кнопка «✏️ Исправить объявления» → «Записать»)")
                ad = engine.build_ad(p, s, [])
                ad["title"] = ed["title"]
                ad_id = _ad_id(p["sites"][sid])
                start = _edit_url(s, p, ad_id)
                import copy
                steps = copy.deepcopy(steps)
                for x in steps:
                    if x.get("action") == "goto" and x.get("url"):
                        x["url"] = _fill_url(x["url"], p, ad_id)
                out.append({"site": {"id": sid, "name": s["name"], "start_url": start or s["start_url"], "edit": True,
                                     "confirm": bool(ed.get("confirm"))},
                            "steps": ensure_publish(steps), "ad": public_ad(ad), "photos": []})
                out[-1]["site"]["steps"] = out[-1].pop("steps")
                continue
            photos = await asyncio.to_thread(images.prepare, p, engine.cfg.get("photo_max_side", 1600), s.get("max_photos") or None)
            while images.LAST_ERRORS:
                engine.log("⚠️ " + images.LAST_ERRORS.pop(0))
            ad = engine.build_ad(p, s, photos)
            out.append({"site": {"id": sid, "name": s["name"], "start_url": s["start_url"],
                                 "steps": ensure_publish(engine.scenario_for(s, p["line"]))},
                        "ad": public_ad(ad), "photos": [file_url(x) for x in photos]})
        if not out:
            raise HTTPException(400, "нет выбранных сайтов для этого товара")
        return {"product": {"id": p["id"], "code": p["code"]}, "sites": out}

    # ---------- исправление уже выставленных объявлений (например, название не по тому шаблону) ----------
    def _ad_id(st):
        import re as _re
        u = st.get("url") or ""
        m = _re.search(r"product_id=(\d+)", u) or _re.search(r"[?&]id=(\d+)", u) or _re.search(r"(\d{6,})", u)
        return m.group(1) if m else ""

    def _fill_url(u, p, ad_id):
        return (u or "").replace("{ad_id}", ad_id).replace("{code}", str(p.get("code") or ""))

    def _edit_url(s, p, ad_id):
        u = (s.get("edit_url") or "").strip()
        return _fill_url(u, p, ad_id) if u else ""

    def _edit_candidates(d):
        sites = set(d.get("sites") or [])
        day = (d.get("date") or "").strip()
        find = (d.get("find") or "").strip()
        out = []
        for p in engine.state["products"].values():
            for sid, st in (p.get("sites") or {}).items():
                # уже поставленные в работу тоже берём — повторный запуск обновляет им новое название
                if sid not in sites or not (st.get("status") == "done" or st.get("edit")):
                    continue
                if day and not str((st.get("edit") or {}).get("prev_at") or st.get("at") or "").startswith(day):
                    continue
                out.append((p, sid, st))
        out.sort(key=lambda x: str(x[2].get("at") or ""))
        return out, find

    def _new_title(p, s, find, repl):
        ad = engine.build_ad(p, s, [])
        t = ad["title"]
        if find and find.lower() in t.lower():
            import re as _re
            return _re.sub(_re.escape(find), repl, t, flags=_re.I).strip()
        # бренд остаётся в названии (как было в выставленном объявлении), если у товара он не выключен
        brand = "" if p.get("no_brand") else (ad.get("brand") or p.get("brand") or "")
        if brand and brand.lower() in repl.lower():
            brand = ""
        return " ".join(x for x in (repl, brand, str(p.get("code") or "")) if x).strip()

    @app.post("/api/edit/preview")
    async def edit_preview(req: Request):
        d = await req.json()
        cands, find = _edit_candidates(d)
        repl = (d.get("replace") or "").strip()
        by = {}
        sites = {s["id"]: s for s in C.load_sites()}
        for p, sid, st in cands:
            by.setdefault(sid, []).append((p, st))
        res = []
        for sid, items in by.items():
            s = sites.get(sid) or {"id": sid, "name": sid}
            samples = [{"code": p.get("code"), "ad_id": _ad_id(st), "title": _new_title(p, s, find, repl) if repl else ""} for p, st in items[:6]]
            res.append({"site": sid, "name": s.get("name", sid), "count": len(items), "samples": samples,
                        "no_id": sum(1 for p, st in items if not _ad_id(st)),
                        "edit_url": s.get("edit_url", ""), "edit_steps": len((s.get("scenarios") or {}).get("__edit") or [])})
        return {"sites": res}

    @app.post("/api/edit/start")
    async def edit_start(req: Request):
        d = await req.json()
        repl = (d.get("replace") or "").strip()
        if not repl:
            raise HTTPException(400, "Впишите новое название")
        cands, find = _edit_candidates(d)
        sites = {s["id"]: s for s in C.load_sites()}
        for sid in {sid for _, sid, _ in cands}:
            if not (sites.get(sid, {}).get("scenarios") or {}).get("__edit"):
                raise HTTPException(400, f"{sites.get(sid, {}).get('name', sid)}: сначала запишите, как исправлять название (кнопка «● Записать исправление»)")
        test = bool(d.get("test"))
        if test:  # повторное нажатие «Проверить на одном» — старая проверка снимается, не копится
            for p in engine.state["products"].values():
                for st in (p.get("sites") or {}).values():
                    if (st.get("edit") or {}).get("confirm"):
                        st.pop("edit", None)
                        st["status"] = "done"
            cands, find = _edit_candidates(d)
        if engine.cfg.get("edit_paused"):
            cfg = C.load_config(); cfg["edit_paused"] = False; C.save_config(cfg); engine.cfg = C.load_config()
        n, seen = 0, set()
        for p, sid, st in cands:
            if test and sid in seen:
                continue  # проверка: только первое объявление на каждом сайте
            t = _new_title(p, sites[sid], find, repl)
            if st.get("title") == t:
                continue  # уже исправлено на это название
            st["edit"] = {"title": t, "prev_at": st.get("at"), **({"confirm": True} if test else {})}
            st["status"] = "pending"
            seen.add(sid)
            n += 1
        engine.save()
        engine.log(f"✏️ Исправление объявлений: поставлено в работу {n} (сайты: {', '.join(sorted({sites[s]['name'] for _, s, _ in cands}))}). Запустите «▶ Авто» или «Пачкой».")
        return {"ok": True, "count": n}

    @app.get("/api/edit/status")
    async def edit_status():
        left = err = 0
        manual = []
        for p in engine.state["products"].values():
            for sid, st in (p.get("sites") or {}).items():
                if st.get("edit_manual"):
                    manual.append(f"{p.get('code')} ({sid})")
                if st.get("edit"):
                    left += 1
                    err += st.get("status") == "error"
        return {"left": left, "errors": err, "done": getattr(engine, "edit_done", 0), "paused": bool(engine.cfg.get("edit_paused")), "manual": manual}

    @app.post("/api/edit/pause")
    async def edit_pause(req: Request):
        d = await req.json()
        cfg = C.load_config()
        cfg["edit_paused"] = bool(d.get("paused"))
        C.save_config(cfg)
        engine.cfg = C.load_config()
        engine.log("✏️ Исправление объявлений: " + ("пауза" if cfg["edit_paused"] else "продолжаю (вперемешку с очередью)"))
        return {"ok": True, "paused": cfg["edit_paused"]}

    @app.post("/api/edit/cancel")
    async def edit_cancel():
        n = 0
        for p in engine.state["products"].values():
            for st in (p.get("sites") or {}).values():
                if st.pop("edit", None) is not None:
                    st["status"] = "done"
                    st.pop("error", None)
                    n += 1
        engine.save()
        engine.log(f"✏️ Исправление объявлений отменено: {n} шт. остались как были")
        return {"ok": True, "count": n}

    @app.post("/api/edit/site")
    async def edit_site(req: Request):
        d = await req.json()
        s = C.get_site(d.get("site"))
        if not s:
            raise HTTPException(404)
        s["edit_url"] = (d.get("edit_url") or "").strip()
        C.save_site(s)
        return {"ok": True}

    @app.get("/api/ext/sample")
    async def ext_sample(site: str, line: str = "default"):
        s = C.get_site(site)
        if not s:
            raise HTTPException(404, "сайт не найден")
        if line == "__edit":  # запись исправления: открываем настоящее выставленное объявление
            last = None
            for p in engine.state["products"].values():
                st = (p.get("sites") or {}).get(site) or {}
                if (st.get("status") == "done" or st.get("edit")) and (not last or str(st.get("at")) > str(last[1].get("at"))):
                    last = (p, st)
            ad = await asyncio.to_thread(engine.sample_ad, s, "default")
            start = s["start_url"]
            if last:
                ad = engine.build_ad(last[0], s, [])
                ad["photos"] = []
                start = _edit_url(s, last[0], _ad_id(last[1])) or start
            ad["title"] = "НОВОЕ НАЗВАНИЕ " + str(ad.get("code") or "")
            return {"site": {"id": s["id"], "name": s["name"], "start_url": start}, "line_name": "✏️ исправление",
                    "ad": public_ad(ad), "photos": []}
        ad = await asyncio.to_thread(engine.sample_ad, s, line)
        ln = engine.line(line)
        return {"site": {"id": s["id"], "name": s["name"], "start_url": s["start_url"]},
                "line_name": ln["name"] if ln else "",
                "ad": public_ad(ad), "photos": [file_url(x) for x in ad["photos"]]}

    @app.post("/api/ext/scenario")
    async def ext_scenario(req: Request):
        from .scenario import ensure_publish
        d = await req.json()
        s = C.get_site(d.get("site"))
        if not s:
            raise HTTPException(404, "сайт не найден")
        steps = ensure_publish(d.get("steps") or [])
        s.setdefault("scenarios", {})[d.get("line") or "default"] = steps
        C.save_site(s)
        has_pub = any(x["action"] == "publish" for x in steps)
        ln = engine.line(d.get("line") or "default")
        if d.get("line") == "__edit":
            ln = {"name": "✏️ исправление названия"}
        engine.log(f"💾 Сценарий {s['name']}{' для линии «' + ln['name'] + '»' if ln else ' (общий)'} сохранён из браузера: {len(steps)} шагов" +
                   ("" if has_pub else " — ⚠️ не отмечена кнопка «Опубликовать»"))
        return {"ok": True, "steps": len(steps), "has_publish": has_pub}

    @app.post("/api/ext/log")
    async def ext_log(req: Request):
        d = await req.json()
        engine.log(str(d.get("text", ""))[:500])
        return {"ok": True}

    @app.get("/api/ext/file")
    async def ext_file(path: str):
        p = Path(path).resolve()
        if C.PREPARED_DIR.resolve() not in p.parents or not p.exists():
            raise HTTPException(404)
        return FileResponse(p, media_type="image/jpeg")

    @app.post("/api/quit")
    async def quit_app():
        engine.log("Выключение программы…")
        asyncio.get_event_loop().call_later(0.5, lambda: engine.quit_event.set())
        return {"ok": True}

    return app
