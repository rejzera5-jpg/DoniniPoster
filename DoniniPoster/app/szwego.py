"""Скачивание товаров из каталога 微商相册 (szwego.com).

Расширение на странице альбома поставщика по очереди присылает товары (текст + ссылки на фото).
Здесь фото скачиваются в отдельную папку товара, размер берётся из описания («尺寸35*30»)
и пишется в название папки и в info.txt — программа сама подставит его в объявление.
"""
import json
import re
import shutil
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config as C

SEEN_FILE = C.DATA / "szwego_seen.json"
DOWNLOAD_DIR = "Скачано WeChat"
_lock = threading.Lock()

NUM = r"(\d{1,3}(?:[.,]\d{1,2})?)"
SEP = r"\s*(?:[*xX×✖✕]|\s(?=\d))\s*"
# «尺寸：35*30», «尺寸35*30*12cm», «size 35x30»
SIZE_AFTER_WORD = re.compile(r"(?:尺寸|尺码|规格|大小|size|Size|SIZE)\s*[:：]?\s*" + NUM + SEP + NUM + r"(?:" + SEP + NUM + r")?")
# запасной вариант: «35*30cm» где угодно в тексте
SIZE_ANY = re.compile(NUM + r"\s*[*xX×✖✕]\s*" + NUM + r"(?:\s*[*xX×✖✕]\s*" + NUM + r")?\s*(?:cm|CM|厘米|公分)?")
PRICE_LINE = re.compile(r"^\s*(?:大号|小号|中号)?\s*[pP]\s*\d+")


def _num(s):
    return s.replace(",", ".")


def parse_sizes(text):
    """Все размеры из описания: ['35*30', '25*19']."""
    found = []
    for m in SIZE_AFTER_WORD.finditer(text or ""):
        found.append("*".join(_num(x) for x in m.groups() if x))
    if not found:
        for m in SIZE_ANY.finditer(text or ""):
            nums = [x for x in m.groups() if x]
            # отбрасываем явно не размеры (например, 1*1)
            if all(1 <= float(_num(x)) <= 300 for x in nums) and max(float(_num(x)) for x in nums) >= 5:
                found.append("*".join(_num(x) for x in nums))
    out = []
    for s in found:
        if s not in out:
            out.append(s)
    return out


EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200B-\u200D\u203C\u2049\u2122\u00AE\u00A9\uFFFC]+")
PRICE_PREFIX = re.compile(r"^\s*(?:大号|小号|中号)?\s*[pP]\s*\d+\S*")
SIZE_TAIL = re.compile(r"(?:尺寸|尺码|规格|大小|size|Size|SIZE)\s*[:：]?\s*[\d.,*xX×✖✕ ]+\s*(?:cm|CM|厘米|公分)?")


def product_name(text):
    """Короткое название для папки: модель из описания без цены, размера и смайликов."""
    for line in (text or "").splitlines():
        line = EMOJI.sub(" ", line)
        line = PRICE_PREFIX.sub(" ", line)
        line = SIZE_TAIL.sub(" ", line)
        line = SIZE_ANY.sub(" ", line)
        line = re.sub(r"高端货|新款|无盒|配盒|折叠盒|飞机盒|双盒包装|[‼！!⚠“”\"'「」【】]", " ", line)
        line = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", line)
        line = re.sub(r"\s+", " ", line).strip(" .,，。:：;；-")
        if len(line) >= 2:
            return line[:40].strip()
    return "товар"


def _load_seen():
    try:
        return json.loads(SEEN_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _save_seen(seen):
    SEEN_FILE.write_text(json.dumps(seen, ensure_ascii=False, indent=0), "utf-8")


def target_dir(cfg, line, dest, shop=""):
    if dest == "queue":
        return Path(cfg["queue_root"]) / line["folder"]
    return C.ROOT / DOWNLOAD_DIR / line["folder"]


def _fetch(url, path):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36",
        "Referer": "https://www.szwego.com/",
    })
    with urllib.request.urlopen(req, timeout=40) as r:
        data = r.read()
    if len(data) < 500:
        raise IOError("пустой файл")
    path.write_bytes(data)


def download_item(cfg, line, dest, shop, item, only_new=True, need_size=True, log=print):
    gid = str(item.get("id") or "")
    text = item.get("title") or ""
    imgs = [u for u in (item.get("imgs") or []) if isinstance(u, str) and u.startswith("http")]
    if not gid or not imgs:
        return {"ok": True, "skipped": True, "reason": "нет фото"}
    with _lock:
        seen = _load_seen()
    if only_new and gid in seen:
        return {"ok": True, "skipped": True, "reason": "уже скачан"}
    sizes = parse_sizes(text)
    if need_size and not sizes:
        return {"ok": True, "skipped": True, "reason": "нет размера"}

    base = target_dir(cfg, line, dest, shop)
    base.mkdir(parents=True, exist_ok=True)
    name = product_name(text)
    if sizes:
        name = f"{name} {' '.join(s.replace('*', 'x') for s in sizes)}"
    name = name[:110].strip()
    # качаем во временную папку «_…» (очередь такие не трогает), потом переименовываем
    tmp = base / f"_загрузка {re.sub(r'[^0-9A-Za-z_-]', '', gid)[-16:]}"
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    errors = []

    def one(args):
        i, url = args
        try:
            _fetch(url, tmp / f"{i:02d}.jpg")
        except Exception as e:  # одно фото не скачалось — остальные оставляем
            errors.append(f"{i}: {e}")

    with ThreadPoolExecutor(max_workers=10) as ex:
        list(ex.map(one, enumerate(imgs, 1)))
    got = len(list(tmp.glob("*.jpg")))
    if not got:
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": False, "error": "не скачалось ни одного фото" + (f" ({errors[0]})" if errors else "")}
    if sizes:
        (tmp / "info.txt").write_text("размер: " + "\\".join(sizes) + " cm\n", "utf-8")
    (tmp / "описание.txt").write_text(text, "utf-8")
    (tmp / ".ready").write_text("", "utf-8")

    final, n = base / name, 2
    while final.exists():
        final, n = base / f"{name} ({n})", n + 1
    tmp.rename(final)
    with _lock:
        seen = _load_seen()
        seen[gid] = final.name
        _save_seen(seen)
    log(f"⬇ WeChat: «{final.name}» — фото {got}" + (f", не скачалось {len(errors)}" if errors else ""))
    return {"ok": True, "folder": final.name, "size": "\\".join(sizes), "photos": got, "failed": len(errors)}
