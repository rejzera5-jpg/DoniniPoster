"""Источники фото для очереди: товары со своего сайта (WooCommerce) → папки в очереди для досок."""
import html
import json
import re
import shutil
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config as C

SEEN_FILE = C.DATA / "woo_pulled.json"
STATE = {"running": False, "done": 0, "total": 0, "skipped": 0, "errors": 0, "stop": False, "msg": ""}
_lock = threading.Lock()


def _seen():
    try:
        return json.loads(SEEN_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _save_seen(d):
    SEEN_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=0), "utf-8")


def _attr(p, attr_id, names):
    for a in p.get("attributes") or []:
        if (attr_id and str(a.get("id")) == str(attr_id)) or any(n in (a.get("name") or "").lower() for n in names):
            opts = a.get("options") or []
            if opts:
                return str(opts[0])
    return ""


def _text(h):
    h = re.sub(r"<br\s*/?>|</p>", "\n", h or "", flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", h))


_DIM = r"\d+(?:[.,]\d+)?\s*(?:cm|см)?\s*[x×хX*/\\]\s*\d+(?:[.,]\d+)?(?:\s*(?:cm|см)?\s*[x×хX*/\\]\s*\d+(?:[.,]\d+)?)*\s*(?:cm|см|mm)?"
_SIZE_WORDS = r"Rozmiar\w*|Wymiar\w*|Wielko\w*|Size|Dimensions?|Размер\w*|Габарит\w*|Długo\w*|Szeroko\w*"


def _size(p, size_attr):
    """Размер товара с сайта: атрибут «Rozmiar», иначе из описания — «Rozmiar: 30x20x10 cm», «Wymiary 26*16*7»,
    «Rozmiar - 148 cm», «Długość: 148 cm», или просто «30 x 20 x 10 cm» где-нибудь в тексте."""
    s = _attr(p, size_attr, ("rozmiar", "wymiar", "size", "размер"))
    if s and re.search(r"\d", s):
        return s.strip()
    text = _text(p.get("description")) + "\n" + _text(p.get("short_description"))
    text = text.replace("\xa0", " ")
    # 1) строка со словом «Rozmiar/Wymiary/…» — то, что после него (двоеточие, тире или пробел)
    for m in re.finditer(rf"(?:{_SIZE_WORDS})\s*(?:\([^)]*\))?\s*[:：\-–—]?\s*([^\n]{{1,80}})", text, re.I):
        v = m.group(1).strip(" .;,")
        if re.search(r"\d", v) and not re.fullmatch(r"0+", v):
            return v
    # 2) размеры вида «30 x 20 x 10 cm» в любом месте описания или в названии
    for src in (text, p.get("name") or ""):
        m = re.search(_DIM, src, re.I)
        if m:
            return m.group(0).strip()
    return s or ""


def _clean(s):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", s or "")
    return re.sub(r"\s+", " ", s).strip(" .")


def _fetch(url, path, tries=3):
    """Скачивает фото. Сайт иногда «подвисает» на одном фото — тогда не ждём минуту, а пробуем ещё раз."""
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 DoniniPoster"})
            with urllib.request.urlopen(req, timeout=15 + 10 * k) as r:
                data = r.read()
            if len(data) < 500:
                raise IOError("пустой файл")
            path.write_bytes(data)
            return
        except Exception as e:
            err = e
            time.sleep(1 + k)
    raise err


def pull_from_woo(woo, cfg, line, category="", search="", limit=50, only_new=True, log=print):
    """Скачивает фото товаров с сайта в папку вида товара («Очередь\\Сумки\\…») — дальше они идут на доски.
    В папку кладётся info.txt с размером, ценой и кодом (артикулом) с сайта."""
    w = cfg.get("woo") or {}
    base = Path(cfg["queue_root"]) / line["folder"]
    base.mkdir(parents=True, exist_ok=True)
    params = {"status": "publish", "orderby": "date", "order": "desc"}
    if category:
        params["category"] = str(category)
    if search:
        params["search"] = search
    STATE.update(running=True, done=0, total=0, skipped=0, errors=0, stop=False, msg="получаю список товаров с сайта…")
    try:
        prods, page = [], 1
        while len(prods) < limit and page < 40:
            chunk = woo.wc("products", params={**params, "per_page": min(100, max(10, limit)), "page": page})
            if not isinstance(chunk, list) or not chunk:
                break
            prods += chunk
            page += 1
            if len(chunk) < min(100, max(10, limit)):
                break
        seen = _seen()
        todo = [p for p in prods if not (only_new and str(p.get("id")) in seen)][:limit]
        STATE.update(total=len(todo), skipped=len(prods[:limit]) - len(todo) if only_new else 0, msg="")
        log(f"🌐→📦 С сайта в «{line['name']}»: товаров {len(todo)}" + (f" (уже скачанные пропущены: {STATE['skipped']})" if STATE["skipped"] else ""))
        for p in todo:
            if STATE["stop"]:
                break
            _pull_one(p, w, base, log)
        STATE["msg"] = f"Готово: в очередь {STATE['done']}" + (f", ошибок {STATE['errors']}" if STATE["errors"] else "")
        log(f"✅ С сайта в «{line['name']}»: скачано {STATE['done']}" + (f", ошибок {STATE['errors']}" if STATE["errors"] else ""))
    except Exception as e:
        STATE["msg"] = f"Ошибка: {e}"
        log(f"⚠️ С сайта: {e}")
    finally:
        STATE["running"] = False


def product_info(p, w):
    brand = _attr(p, w.get("brand_attr"), ("marka", "brand", "бренд")) or (p.get("name") or "").split(" ")[0]
    return brand, _size(p, w.get("size_attr"))


def _pull_one(p, w, base, log):
    """Один товар сайта → папка в очереди. True — скачан."""
    try:
        imgs = [i.get("src") for i in p.get("images") or [] if i.get("src")]
        if not imgs:
            STATE["skipped"] += 1
            return False
        brand, size = product_info(p, w)
        if not size:
            snip = re.sub(r"\s+", " ", _text(p.get("description")))[:160]
            log(f"⚠️ Размер не найден в описании «{p.get('name')}» — впишите его в очереди. Начало описания: «{snip}»")
        sku = str(p.get("sku") or "").strip()
        name = _clean(f"{brand} {size.replace('*', 'x').replace('cm', '').strip()}")[:90] or f"товар {p.get('id')}"
        tmp = base / f"_загрузка_сайт_{p.get('id')}"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)

        def one(a):
            i, u = a
            _fetch(u, tmp / f"{i:02d}.jpg")
        with ThreadPoolExecutor(max_workers=6) as ex:
            list(ex.map(one, enumerate(imgs, 1)))
        info = []
        if size:
            info.append(f"размер: {size if 'cm' in size.lower() else size + ' cm'}")
        if p.get("regular_price") or p.get("price"):
            info.append(f"цена: {p.get('regular_price') or p.get('price')}")
        if sku.isdigit():
            info.append(f"код: {sku}")
        (tmp / "info.txt").write_text("\n".join(info) + "\n", "utf-8")
        (tmp / "с сайта.txt").write_text(f"{p.get('name')}\n{p.get('permalink')}\n", "utf-8")
        (tmp / ".ready").write_text("", "utf-8")
        with _lock:
            final, n = base / name, 2
            while final.exists():
                final, n = base / f"{name} ({n})", n + 1
            tmp.rename(final)
            seen = _seen()
            seen[str(p.get("id"))] = final.name
            _save_seen(seen)
        with _lock:
            STATE["done"] += 1
        return True
    except Exception as e:
        shutil.rmtree(base / f"_загрузка_сайт_{p.get('id')}", ignore_errors=True)
        with _lock:
            STATE["errors"] += 1
        log(f"⚠️ С сайта: товар «{p.get('name')}» не скачался: {e}")
        return False


_PENDING = []  # (line, id) — клики по товарам в каталоге копятся здесь, качает один поток по очереди


def pull_ids(woo, cfg, line, ids, log=print, resolve=None):
    """Выбранные в каталоге товары сайта → в очередь вида товара (можно кликать дальше, пока качается)."""
    with _lock:
        _PENDING.extend((line, i, resolve) for i in ids)
        if STATE["running"]:
            STATE["total"] += len(ids)
            return
        STATE.update(running=True, done=0, total=len(ids), skipped=0, errors=0, stop=False, msg="", done_ids={}, failed_ids=[])
    w = cfg.get("woo") or {}

    def one(ln, pid, rs):
        p = None
        for k in range(2):
            try:
                p = woo.wc(f"products/{int(pid)}")
                break
            except Exception as e:
                if k:
                    with _lock:
                        STATE["errors"] += 1
                        STATE.setdefault("failed_ids", []).append(str(pid))
                    log(f"⚠️ С сайта: товар {pid} не получен: {e}")
                    return
                time.sleep(2)
        if rs:
            try:
                ln = rs(p)  # вид товара — по категории на сайте
            except Exception as e:
                log(f"⚠️ Вид товара не определился ({e}) — кладу в «{ln['name']}»")
        base = Path(cfg["queue_root"]) / ln["folder"]
        base.mkdir(parents=True, exist_ok=True)
        if _pull_one(p, w, base, log):
            with _lock:
                STATE.setdefault("done_ids", {})[str(pid)] = ln["name"]
            log(f"📥 С сайта → «{ln['name']}»: {p.get('name')}")
        else:
            with _lock:
                STATE.setdefault("failed_ids", []).append(str(pid))

    def worker():
        while True:
            with _lock:
                if not _PENDING or STATE["stop"]:
                    return
                ln, pid, rs = _PENDING.pop(0)
            try:
                one(ln, pid, rs)
            except Exception as e:
                log(f"⚠️ С сайта: товар {pid}: {e}")

    try:
        while True:
            # 3 товара качаются одновременно — в 2–3 раза быстрее, чем по одному
            ts = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            with _lock:
                if STATE["stop"] or not _PENDING:
                    _PENDING.clear()
                    STATE["msg"] = f"Готово: в очередь {STATE['done']}" + (f", ошибок {STATE['errors']}" if STATE["errors"] else "")
                    STATE["running"] = False
                    return
    finally:
        STATE["running"] = False


WORKERS = 3


def pulled_ids():
    return set(_seen().keys())
