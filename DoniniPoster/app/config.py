"""Настройки программы. Всё хранится в папке data/ рядом с программой."""
import json
import os
import re
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITES_DIR = DATA / "sites"
PROFILE_DIR = DATA / "chrome-profile"
PREPARED_DIR = DATA / "prepared"
SHOTS_DIR = DATA / "screenshots"
CONFIG_FILE = DATA / "config.json"
STATE_FILE = DATA / "state.json"

_lock = threading.RLock()


def _atomic_write(path, text):
    """Надёжная запись файла. На Windows антивирус (например Dr.Web) может на мгновение
    занять только что созданный файл — тогда ждём и пробуем ещё раз."""
    import time
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, "utf-8")
    for i in range(15):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.2 * (i + 1))
    # в крайнем случае пишем напрямую
    path.write_text(text, "utf-8")
    try:
        tmp.unlink()
    except OSError:
        pass

# Сайты по умолчанию. Шаги (steps) пустые — их записывает пользователь кнопкой «Записать».
DEFAULT_SITES = [
    {"id": "kleinanzeigen", "name": "Kleinanzeigen.de", "lang": "DE", "start_url": "https://www.kleinanzeigen.de/", "type": "ext"},
    {"id": "marktplaats", "name": "Marktplaats.nl", "lang": "NL", "start_url": "https://www.marktplaats.nl/", "type": "ext"},
    {"id": "jofogas", "name": "Jófogás.hu", "lang": "HU", "start_url": "https://www.jofogas.hu/", "type": "ext"},
    {"id": "vatera", "name": "Vatera.hu", "lang": "HU", "start_url": "https://www.vatera.hu/", "type": "ext"},
    {"id": "sbazar", "name": "Sbazar.cz", "lang": "CZ", "start_url": "https://www.sbazar.cz/", "type": "ext"},
    {"id": "milanuncios", "name": "Milanuncios.com", "lang": "ES", "start_url": "https://www.milanuncios.com/", "type": "ext"},
    {"id": "olx_pl", "name": "OLX.pl", "lang": "PL", "start_url": "https://www.olx.pl/", "type": "ext"},
    {"id": "olx_ro", "name": "OLX.ro", "lang": "RO", "start_url": "https://www.olx.ro/", "type": "ext"},
    {"id": "olx_pt", "name": "OLX.pt", "lang": "PT", "start_url": "https://www.olx.pt/", "type": "ext"},
]

SITE_DEFAULTS = {
    "enabled": True,
    "type": "scenario",          # scenario = записанный сценарий; plugin = python-модуль из папки plugins/;
                                 # ext = «в моём браузере»: заполняет расширение Donini в вашем браузере, публикуете вы
    "plugin": "",
    "min_interval_min": 10,      # не чаще одного объявления раз в N минут на этом сайте
    "jitter_pct": 30,            # случайный разброс паузы, %
    "daily_limit": 60,           # максимум объявлений в день на сайт
    "max_photos": 10,
    "title_spaces": 0,           # сколько пробелов добавлять в конце названия на этом сайте
    "confirm_before_publish": False,  # True = остановиться перед «Опубликовать» и ждать вас
    "scenarios": {},             # {"default": [шаги], "<id линии>": [шаги]}
}

DEFAULT_CONFIG = {
    "port": 8765,
    "code_counter": 83277,          # последний использованный код; следующий будет +1
    "shared_counter": True,         # один счётчик кодов на все линии
    "queue_root": str(ROOT / "Очередь"),
    "done_root": str(ROOT / "Выставлено"),
    "delete_done_after_days": 3,    # через сколько дней удалять фото выставленных товаров (0 = не удалять)
    "work_hours": [8, 22],          # выставлять только в это время
    "rates": {"EUR": 0.228504, "HUF": 84.103327, "RON": 1.210063, "CZK": 5.589892},
    "photo_max_side": 1600,
    "telegram": {"token": "", "chat_id": ""},
    "browser_channel": "chrome",    # chrome = ваш установленный Chrome; пусто = встроенный Chromium
    "proxy": "",                    # необязательно: прокси для браузера программы (socks5://host:port)
    "lines": [
        {"id": "bags", "name": "Сумки", "folder": "Сумки", "template": "bags",
         "default_size": "21*14\\26*16\\30*19 cm", "default_price": 0,
         "sites": ["kleinanzeigen", "marktplaats", "jofogas", "vatera", "sbazar", "olx_pl", "olx_ro", "olx_pt"],
         "counter": 83277},
        {"id": "other", "name": "Другой товар", "folder": "Другое", "template": "wallets",
         "default_size": "", "default_price": 0, "sites": ["sbazar", "olx_pl"], "counter": 0},
    ],
    "custom_templates": [],
}


def _merge(defaults, data):
    out = dict(defaults)
    out.update(data or {})
    return out


def load_config():
    with _lock:
        DATA.mkdir(exist_ok=True)
        if CONFIG_FILE.exists():
            cfg = _merge(DEFAULT_CONFIG, json.loads(CONFIG_FILE.read_text("utf-8")))
        else:
            cfg = json.loads(json.dumps(DEFAULT_CONFIG))
            save_config(cfg)
        # программу перенесли в другую папку (переустановка Windows, другой компьютер) — пути очереди переносим следом
        old_root, new_root = cfg.get("_root"), str(ROOT)
        if not old_root:
            q = str(cfg.get("queue_root") or "")
            old_root = q[: -len("Очередь")].rstrip("\\/") if q.endswith("Очередь") else None
        if old_root and old_root != new_root:
            def fix(v):
                return new_root + v[len(old_root):] if isinstance(v, str) and v.startswith(old_root) else v
            cfg["queue_root"], cfg["done_root"] = fix(cfg.get("queue_root")), fix(cfg.get("done_root"))
            for l in cfg["lines"]:
                l["folder"] = fix(l.get("folder"))
            cfg["_root"] = new_root
            save_config(cfg)
        elif cfg.get("_root") != new_root:
            cfg["_root"] = new_root
            save_config(cfg)
        # своя очередь для загрузки товаров на свой сайт doninisklep.com (добавляется один раз)
        if not cfg.get("_site_line_added") and not any(l.get("id") == "site" for l in cfg["lines"]):
            base = next((l for l in cfg["lines"] if l.get("id") == "bags"), cfg["lines"][0] if cfg["lines"] else {})
            cfg["lines"].append({"id": "site", "name": "Мой сайт", "folder": str(ROOT / "Очередь сайта"),
                                 "template": base.get("template", "bags"), "default_size": "",
                                 "default_price": base.get("default_price", 0), "sites": ["doninisklep"], "counter": 0})
            cfg["_site_line_added"] = True
            save_config(cfg)
        # чехлы для телефонов — своя вкладка очереди со своим шаблоном (модель телефона вместо размера)
        if not cfg.get("_cases_line_added") and not any(l.get("template") == "phonecases" for l in cfg["lines"]):
            w = next((l for l in cfg["lines"] if l.get("template") == "wallets"), {})
            cfg["lines"].append({"id": "cases", "name": "Чехлы", "folder": "Чехлы", "template": "phonecases",
                                 "default_size": "", "default_price": 399, "sites": list(w.get("sites") or []), "counter": 0})
            cfg["_cases_line_added"] = True
            save_config(cfg)
        # цена чехлов по умолчанию — 399 зл (один раз; дальше её можно менять в настройках вида товара)
        if not cfg.get("_cases_price_set"):
            for l in cfg["lines"]:
                if l.get("template") == "phonecases" and not l.get("default_price"):
                    l["default_price"] = 399
            cfg["_cases_price_set"] = True
            save_config(cfg)
        # очередь сайта — отдельная папка «Очередь сайта» рядом с «Очередь», чтобы не путать с досками
        site_dir = str(ROOT / "Очередь сайта")
        for l in cfg["lines"]:
            if l.get("id") == "site" and l.get("folder") == "Мой сайт":
                old = Path(cfg["queue_root"]) / "Мой сайт"
                Path(site_dir).mkdir(parents=True, exist_ok=True)
                try:
                    if old.exists():
                        for x in old.iterdir():
                            x.rename(Path(site_dir) / x.name)
                        old.rmdir()
                except OSError:
                    pass
                l["folder"] = site_dir
                save_config(cfg)
        Path(cfg["queue_root"]).mkdir(parents=True, exist_ok=True)
        for line in cfg["lines"]:
            (Path(cfg["queue_root"]) / line["folder"]).mkdir(parents=True, exist_ok=True)
        return cfg


def save_config(cfg):
    with _lock:
        DATA.mkdir(exist_ok=True)
        _atomic_write(CONFIG_FILE, json.dumps(cfg, ensure_ascii=False, indent=2))


def slug(text):
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or "site"


# ---- Сайты: один JSON-файл на сайт в data/sites ----
def load_sites():
    with _lock:
        SITES_DIR.mkdir(parents=True, exist_ok=True)
        marker = SITES_DIR / ".initialized"
        if not marker.exists():
            # первый запуск: создаём сайты по умолчанию (если сбой — досоздадим при следующем запуске)
            for s in DEFAULT_SITES:
                if not (SITES_DIR / f"{s['id']}.json").exists():
                    save_site(_merge(SITE_DEFAULTS, s))
            marker.write_text("1", "utf-8")
        sites = []
        for f in sorted(SITES_DIR.glob("*.json")):
            try:
                s = _merge(SITE_DEFAULTS, json.loads(f.read_text("utf-8")))
            except Exception:
                continue
            # переход на расширение (один раз): сайты без сценария и старый «полуавтомат» → «в моём браузере»
            mig = SITES_DIR / ".ext_migrated"
            if s.get("type") == "manual" or (not mig.exists() and s.get("type") == "scenario"
                                               and not s.get("scenarios") and s["id"] != "sbazar"):
                s.update(type="ext", name=s["name"].replace(" (браузер)", ""))
                if s["id"].startswith("olx_"):
                    s["enabled"] = True
                save_site(s)
            # Sbazar тоже переводим в «в моём браузере» (один раз; записанный сценарий сохраняется)
            if s["id"] == "sbazar" and s.get("type") == "scenario" and not (SITES_DIR / ".sbazar_ext").exists():
                s["type"] = "ext"
                save_site(s)
            sites.append(s)
        (SITES_DIR / ".ext_migrated").write_text("1", "utf-8")
        (SITES_DIR / ".sbazar_ext").write_text("1", "utf-8")
        return sites


def get_site(site_id):
    f = SITES_DIR / f"{site_id}.json"
    if not f.exists():
        return None
    return _merge(SITE_DEFAULTS, json.loads(f.read_text("utf-8")))


def save_site(site):
    with _lock:
        SITES_DIR.mkdir(parents=True, exist_ok=True)
        f = SITES_DIR / f"{site['id']}.json"
        _atomic_write(f, json.dumps(site, ensure_ascii=False, indent=2))


def delete_site(site_id):
    with _lock:
        f = SITES_DIR / f"{site_id}.json"
        if f.exists():
            f.unlink()


# ---- Состояние очереди ----
def load_state():
    with _lock:
        if STATE_FILE.exists():
            try:
                return json.loads(STATE_FILE.read_text("utf-8"))
            except Exception:
                pass
        return {"products": {}, "daily": {}, "paused": True}


def save_state(state):
    with _lock:
        DATA.mkdir(exist_ok=True)
        _atomic_write(STATE_FILE, json.dumps(state, ensure_ascii=False, indent=2))
