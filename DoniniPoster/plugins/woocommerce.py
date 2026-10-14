"""Загрузка товаров на свой сайт WooCommerce (doninisklep.com) — напрямую через API сайта, без браузера.

Ключи берутся из настроек программы (вкладка «Настройки» → «Мой сайт (WooCommerce)»):
  url        — адрес сайта, например https://doninisklep.com
  ck, cs     — ключ WooCommerce (WooCommerce → Настройки → Дополнительно → REST API), права «Чтение/Запись»
  wp_user    — логин WordPress, wp_pass — «Пароль приложения» (Пользователи → Профиль) — для загрузки фото
  status     — publish (сразу на сайте) или draft (черновик)
  category   — id категории; brand_attr / size_attr — id атрибутов «Бренд» и «Размер»
"""
import base64
import json
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def _contexts():
    import ssl
    yield None
    try:
        import certifi
        yield ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass


def _human(code, text):
    t = (text or "")[:300]
    try:
        j = json.loads(text)
        srv = f"{j.get('code', '')}: {j.get('message', '')}".strip(": ")
    except Exception:
        srv = t[:120]
    if code == 401:
        return f"сайт не пустил (401) — {srv}"
    if code == 403:
        return "у ключа нет прав (403). Ключ WooCommerce должен быть с правами «Чтение/Запись»"
    if code == 404:
        return "адрес API не найден (404). Проверьте адрес сайта и что в WordPress включены «Постоянные ссылки» (не «Простые»)"
    try:
        j = json.loads(text)
        return f"сайт ответил ошибкой {code}: {j.get('message') or j.get('code') or t}"
    except Exception:
        return f"сайт ответил ошибкой {code}: {t}"


class SiteDown(RuntimeError):
    """Сайт временно не отвечает (упал, перегружен, 5xx) — стоит подождать и повторить."""


def _request(url, method="GET", data=None, headers=None, timeout=60):
    last = None
    for ctx in _contexts():
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                body = r.read().decode("utf-8", "ignore")
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "ignore")
            if e.code >= 500 or e.code in (408, 429):
                raise SiteDown(f"сайт временно не отвечает ({e.code})") from None
            raise RuntimeError(_human(e.code, txt)) from None
        except Exception as e:
            last = e
            if "CERTIFICATE" not in str(e).upper():
                break
    raise SiteDown(f"нет связи с сайтом ({last})")


AUTH_HINT = ("Проверьте логин WordPress и «Пароль приложения». Если они верные, а ошибка «rest_cannot_create … not allowed» — "
             "хостинг срезает пароль: в файл .htaccess сайта нужно добавить строку "
             "SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1")


class Woo:
    def __init__(self, cfg):
        w = cfg.get("woo") or {}
        self.w = w
        self.base = (w.get("url") or "").strip().rstrip("/")
        if self.base and not self.base.startswith("http"):
            self.base = "https://" + self.base
        if not (self.base and w.get("ck") and w.get("cs")):
            raise RuntimeError("не заполнены адрес сайта и ключи WooCommerce (Настройки → «Мой сайт (WooCommerce)»)")

    def _wc_headers(self):
        tok = base64.b64encode(f"{self.w['ck']}:{self.w['cs']}".encode()).decode()
        return {"Authorization": f"Basic {tok}", "Content-Type": "application/json", "Accept": "application/json",
                "User-Agent": "DoniniPoster/1.0"}

    def wc(self, path, method="GET", payload=None, params=None):
        q = dict(params or {})
        # ключи и в адресе тоже: некоторые хостинги срезают заголовок Authorization
        q.update(consumer_key=self.w["ck"], consumer_secret=self.w["cs"])
        url = f"{self.base}/wp-json/wc/v3/{path}?{urllib.parse.urlencode(q)}"
        data = json.dumps(payload).encode() if payload is not None else None
        return _request(url, method, data, self._wc_headers())

    def wc_all(self, path, params=None):
        out, page = [], 1
        while page < 50:
            chunk = self.wc(path, params={**(params or {}), "per_page": 100, "page": page})
            if not isinstance(chunk, list) or not chunk:
                break
            out += chunk
            if len(chunk) < 100:
                break
            page += 1
        return out

    def upload_photo(self, path):
        user, pw = (self.w.get("wp_user") or "").strip(), (self.w.get("wp_pass") or "").replace(" ", "")
        if not (user and pw):
            raise RuntimeError("для загрузки фото нужен логин WordPress и «Пароль приложения» (Настройки → «Мой сайт»)")
        p = Path(path)
        tok = base64.b64encode(f"{user}:{pw}".encode()).decode()
        mime = mimetypes.guess_type(p.name)[0] or "image/jpeg"
        headers = {"Authorization": f"Basic {tok}", "Content-Type": mime, "User-Agent": "DoniniPoster/1.0",
                   "Content-Disposition": f'attachment; filename="{urllib.parse.quote(p.name)}"'}
        try:
            r = _request(f"{self.base}/wp-json/wp/v2/media", "POST", p.read_bytes(), headers, timeout=120)
        except SiteDown:
            raise
        except RuntimeError as e:
            raise RuntimeError(f"загрузка фото: {e}. {AUTH_HINT}") from None
        if not r.get("id"):
            raise RuntimeError("сайт не вернул номер загруженного фото")
        return r["id"]

    # ----- товар-образец («Duplicate»): берём готовый товар с сайта и копируем его -----
    def find_product(self, ref):
        """ref: номер (ID), ссылка на товар / на его редактирование, или артикул."""
        import re
        ref = (ref or "").strip()
        if not ref:
            return None
        m = re.search(r"(?:post|p)=(\d+)", ref) or re.fullmatch(r"(\d+)", ref)
        if m:
            return self.wc(f"products/{m.group(1)}")
        if ref.startswith("http"):
            slug = [x for x in urllib.parse.urlparse(ref).path.split("/") if x]
            if slug:
                r = self.wc("products", params={"slug": slug[-1], "status": "any"})
                if isinstance(r, list) and r:
                    return r[0]
        r = self.wc("products", params={"sku": ref, "status": "any"})
        if isinstance(r, list) and r:
            return r[0]
        raise RuntimeError(f"товар-образец «{ref}» не найден на сайте")

    def check_wp_auth(self):
        """Проверка логина и пароля приложения (нужны для загрузки фото)."""
        user, pw = (self.w.get("wp_user") or "").strip(), (self.w.get("wp_pass") or "").replace(" ", "")
        if not (user and pw):
            return "не заполнены логин WordPress и пароль приложения"
        tok = base64.b64encode(f"{user}:{pw}".encode()).decode()
        try:
            me = _request(f"{self.base}/wp-json/wp/v2/users/me?context=edit", "GET", None,
                          {"Authorization": f"Basic {tok}", "User-Agent": "DoniniPoster/1.0"})
        except RuntimeError as e:
            return f"{e}. {AUTH_HINT}"
        caps = me.get("capabilities") or {}
        if caps and not caps.get("upload_files"):
            return f"пользователь «{me.get('name') or user}» не может загружать файлы — нужен администратор или редактор"
        return ""

    # ----- для окна настроек: что есть на сайте -----
    def lists(self):
        cats = self.wc_all("products/categories", {"orderby": "name"})
        attrs = self.wc("products/attributes")
        return {"categories": [{"id": c["id"], "name": c["name"], "parent": c.get("parent", 0), "count": c.get("count", 0)} for c in cats],
                "attributes": [{"id": a["id"], "name": a["name"]} for a in (attrs or [])]}


def _brand_term(woo, attr_id, brand):
    """Бренд из названия папки → точное название, которое уже есть на сайте (Louis Vuitton / LOUIS VUITTON / LV)."""
    if not brand:
        return ""
    cache = woo.w.setdefault("_terms", {})
    key = str(attr_id)
    if key not in cache:
        try:
            cache[key] = [t["name"] for t in woo.wc_all(f"products/attributes/{attr_id}/terms")]
        except Exception:
            cache[key] = []
    norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum())
    for t in cache[key]:
        if norm(t) == norm(brand):
            return t
    for t in cache[key]:
        if norm(brand) in norm(t) or (len(norm(t)) > 2 and norm(t) in norm(brand)):
            return t
    return brand  # такого бренда на сайте ещё нет — сайт создаст его сам


_UPLOADED = {}  # код товара -> {путь фото: id на сайте}: при повторе после падения сайта фото заново не грузим


async def post(page, ad, site, engine, dry_run=False):
    """Сайт иногда падает на несколько минут — ждём и повторяем (до ~20 минут), потом сдаёмся."""
    import asyncio
    waits = [20, 40, 60, 90, 120, 180, 240, 300, 300]
    told = False
    for n in range(len(waits) + 1):
        try:
            res = await _post_once(ad, engine)
            if told:
                engine.log(f"✅ {site.get('name', 'сайт')} снова отвечает — продолжаю загрузку")
            return res
        except SiteDown as e:
            if n >= len(waits):
                raise RuntimeError(f"{e} — сайт не поднялся за ~20 минут, товар пропущен (останется в очереди с ошибкой)")
            if not told:
                engine.log(f"⚠️ {site.get('name', 'сайт')} не отвечает ({e}) — жду и пробую снова, загрузка продолжится сама")
                told = True
            await asyncio.sleep(waits[n])


async def _post_once(ad, engine):
    import asyncio
    woo = Woo(engine.cfg)
    w = woo.w
    # 1) фото (уже загруженные в прошлой попытке — не повторяем)
    done = _UPLOADED.setdefault(str(ad["code"]), {})
    ids = []
    for ph in ad["photos"]:
        if ph not in done:
            done[ph] = await asyncio.to_thread(woo.upload_photo, ph)
        ids.append(done[ph])
    tpl_ref = (w.get("template") or "").strip()
    if tpl_ref:
        prod = await asyncio.to_thread(_from_template, woo, tpl_ref, ad, ids)
    else:
        prod = _from_texts(woo, ad, ids)
    # товар с таким кодом уже есть (повторный запуск) — обновляем его, а не создаём дубль
    try:
        found = await asyncio.to_thread(woo.wc, "products", "GET", None, {"sku": str(ad["code"])})
    except SiteDown:
        raise
    except Exception:
        found = []
    try:
        if isinstance(found, list) and found:
            r = await asyncio.to_thread(woo.wc, f"products/{found[0]['id']}", "PUT", prod)
        else:
            r = await asyncio.to_thread(woo.wc, "products", "POST", prod)
    except SiteDown:
        raise
    except RuntimeError as e:
        raise RuntimeError(f"создание товара: {e}. Ключ WooCommerce должен быть с правами «Чтение/Запись»") from None
    if not r.get("id"):
        raise RuntimeError("сайт не вернул номер товара")
    _UPLOADED.pop(str(ad["code"]), None)
    return r.get("permalink") or f"{woo.base}/?p={r['id']}"


_TPL = {}


def _attr_option(prod, attr_id, names):
    for a in prod.get("attributes") or []:
        if (attr_id and str(a.get("id")) == str(attr_id)) or any(n in (a.get("name") or "").lower() for n in names):
            return a, ((a.get("options") or [""])[0])
    return None, ""


def _put_size(text, size, only_replace=False):
    """Размер из очереди в описание: строку «Rozmiar:/Wymiary:» обновляем,
    а если её нет — вставляем «Rozmiar: …» перед «Materiał: …» (или в начало)."""
    import re
    text = text or ""
    size = (size or "").strip()
    if not size:
        return text
    if re.fullmatch(r"[\d.,]+(\s*[x×х*]\s*[\d.,]+){1,2}", size, flags=re.I):
        size += " cm"
    pat = re.compile(r"((?:Rozmiar|Wymiary|Wymiar)\s*:\s*)([^<\n\r]*)", re.I)
    if pat.search(text):
        return pat.sub(lambda m: m.group(1) + size, text, count=1)
    if only_replace or not text.strip():
        return text
    br = "<br />\n" if re.search(r"<br\s*/?>", text, re.I) else "\n"
    line = f"Rozmiar: {size}"
    m = re.search(r"Materia[łl]\s*:", text, re.I)
    if m:
        return text[:m.start()] + line + br + text[m.start():]
    m = re.match(r"\s*(<p[^>]*>)?", text, re.I)
    return text[:m.end()] + line + br + text[m.end():]


def _from_template(woo, ref, ad, ids):
    """Как «Duplicate» в админке: копия товара-образца, в которой меняются фото, артикул (код), бренд и размер."""
    import re
    w = woo.w
    if _TPL.get("ref") != ref:
        _TPL.clear()
        _TPL.update(ref=ref, p=woo.find_product(ref))
    t = _TPL["p"]
    old_code = str(t.get("sku") or "")
    _, old_brand = _attr_option(t, w.get("brand_attr"), ("marka", "brand", "бренд"))
    _, old_size = _attr_option(t, w.get("size_attr"), ("rozmiar", "wymiar", "size", "размер"))
    new_brand = _brand_term(woo, w["brand_attr"], ad["brand"]) if (w.get("brand_attr") and ad.get("brand")) else (ad.get("brand") or "")
    new_size, new_code = ad.get("size") or "", str(ad["code"])

    def swap(text):
        text = text or ""
        if old_code and new_code:
            text = text.replace(old_code, new_code)
        if old_brand and new_brand:
            text = re.sub(re.escape(old_brand), new_brand, text, flags=re.I)
        if old_size and new_size:
            text = text.replace(old_size, new_size)
        return text

    # пометка дубликата WordPress («(Copy)», «(Kopia)», «(Копия)», «- Copy») — убираем
    name = re.sub(r"\s*[\(\[]\s*(copy|kopia|копия|kopie|copia)(\s*\d+)?\s*[\)\]]|\s+[-–]\s*(copy|kopia|копия)\b", "", swap(t.get("name")), flags=re.I)
    name = re.sub(r"\s{2,}", " ", name).strip()
    if new_code and new_code not in name and old_code and old_code not in (t.get("name") or ""):
        pass  # в названии образца кода не было — и не добавляем
    prod = {
        "name": name,
        "type": "simple",
        "status": w.get("status") or "publish",
        "description": _put_size(swap(t.get("description")), new_size),
        "short_description": _put_size(swap(t.get("short_description")), new_size, only_replace=True),
        "sku": new_code,
        # цена — из очереди (поле «Цена» у товара / цена в названии папки / цена линии), а не из образца
        "regular_price": str(ad["price"]) if ad.get("price") not in ("", None, 0) else (t.get("regular_price") or ""),
        "categories": [{"id": c["id"]} for c in t.get("categories") or []],
        "tags": [{"id": x["id"]} for x in t.get("tags") or []],
        "images": [{"id": i} for i in ids],
        "manage_stock": t.get("manage_stock", False),
        "stock_status": t.get("stock_status") or "instock",
        "shipping_class": t.get("shipping_class") or "",
        "weight": t.get("weight") or "",
        "dimensions": t.get("dimensions") or {},
        "catalog_visibility": t.get("catalog_visibility") or "visible",
    }
    # цена образца по акции у новых товаров не нужна (иначе на сайте показывалась бы она, а не ваша цена)
    prod["sale_price"] = "" if ad.get("price") not in ("", None, 0) else (t.get("sale_price") or "")
    if t.get("manage_stock") and t.get("stock_quantity") is not None:
        prod["stock_quantity"] = t["stock_quantity"]
    attrs = []
    for a in t.get("attributes") or []:
        a2 = {k: a[k] for k in ("id", "name", "position", "visible", "variation", "options") if k in a}
        if not a2.get("id"):
            a2.pop("id", None)
        opt = (a.get("options") or [""])[0]
        if old_brand and opt == old_brand and new_brand:
            a2["options"] = [new_brand]
        elif old_size and opt == old_size and new_size:
            a2["options"] = [new_size]
        attrs.append(a2)
    # в образце нет атрибута бренда/размера, а в настройках он выбран — добавляем
    if w.get("brand_attr") and new_brand and not any(str(a.get("id")) == str(w["brand_attr"]) for a in attrs):
        attrs.append({"id": int(w["brand_attr"]), "options": [new_brand], "visible": True})
    if w.get("size_attr") and new_size and not any(str(a.get("id")) == str(w["size_attr"]) for a in attrs):
        attrs.append({"id": int(w["size_attr"]), "options": [new_size], "visible": True})
    prod["attributes"] = attrs
    # прочие поля плагинов (без служебных «_…») — тоже копируем, как делает «Duplicate»
    meta = [{"key": m["key"], "value": m["value"]} for m in t.get("meta_data") or [] if not str(m.get("key", "")).startswith("_")]
    if meta:
        prod["meta_data"] = meta
    return prod


def _from_texts(woo, ad, ids):
    w = woo.w
    prod = {
        "name": ad["title"].strip(),
        "type": "simple",
        "status": w.get("status") or "publish",
        "description": ad["body"].replace("\n", "<br>\n"),
        "sku": str(ad["code"]),
        "images": [{"id": i} for i in ids],
    }
    if ad.get("price") not in ("", None):
        prod["regular_price"] = str(ad["price"])
    if w.get("category"):
        prod["categories"] = [{"id": int(w["category"])}]
    attrs = []
    if w.get("brand_attr") and ad.get("brand"):
        attrs.append({"id": int(w["brand_attr"]), "options": [_brand_term(woo, w["brand_attr"], ad["brand"])],
                      "visible": True})
    if w.get("size_attr") and ad.get("size"):
        attrs.append({"id": int(w["size_attr"]), "options": [ad["size"]], "visible": True})
    if attrs:
        prod["attributes"] = attrs
    return prod
