"""Обновления программы с GitHub: проверка новой версии, скачивание и установка без потери данных.

Источник: репозиторий GitHub «владелец/имя» (файл app/update_source.txt или настройка update_repo).
В релизе GitHub должен лежать архив *update*.zip с папкой DoniniPoster внутри (собирается вместе с установщиком).
Ставится при следующем запуске программы: файлы программы заменяются, папка data (настройки, ключи,
сценарии, очередь) и папки очереди не трогаются."""
import json
import shutil
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from . import config as C

VERSION_FILE = C.ROOT / "app" / "VERSION"
SOURCE_FILE = C.ROOT / "app" / "update_source.txt"
UPDATE_ZIP = C.DATA / "_update.zip"
UPDATE_DIR = C.DATA / "_update"
KEEP = {"data", "DoniniPoster_Setup.exe", "ЧТО_НОВОГО.txt", "python", "Очередь", "Очередь сайта", "Выставлено", "Скачано WeChat", "_старая_версия"}


def current_version():
    try:
        return VERSION_FILE.read_text("utf-8").strip() or "0"
    except OSError:
        return "0"


def _vt(v):
    return tuple(int(x) for x in "".join(c if c.isdigit() else " " for c in str(v)).split()[:4])


def source(cfg=None):
    cfg = cfg or C.load_config()
    repo = (cfg.get("update_repo") or "").strip()
    if not repo:
        try:
            repo = SOURCE_FILE.read_text("utf-8").strip()
        except OSError:
            repo = ""
    repo = repo.replace("https://github.com/", "").strip("/ ")
    return repo if repo.count("/") == 1 else ""


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "DoniniPoster-updater", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


BRANCH = "main"


def _branch_info(repo):
    """Версия, лежащая в репозитории (папка DoniniPoster в ветке main) — так обновления выкладываются без «выпусков»."""
    raw = f"https://raw.githubusercontent.com/{repo}/{BRANCH}/DoniniPoster"
    latest = _get(f"{raw}/app/VERSION?t={int(time.time())}", timeout=20).decode("utf-8", "replace").strip()
    try:
        notes = _get(f"{raw}/" + urllib.parse.quote("ЧТО_НОВОГО.txt") + f"?t={int(time.time())}", timeout=20).decode("utf-8", "replace").strip()
    except Exception:
        notes = ""
    return {"latest": latest, "notes": notes[:2000],
            "url": f"https://codeload.github.com/{repo}/zip/refs/heads/{BRANCH}",
            "setup_url": f"https://github.com/{repo}/raw/{BRANCH}/DoniniPoster_Setup.exe",
            "page": f"https://github.com/{repo}"}


def _release_info(repo):
    rel = json.loads(_get(f"https://api.github.com/repos/{repo}/releases/latest"))
    asset = next((a for a in rel.get("assets") or [] if a.get("name", "").endswith(".zip") and "update" in a.get("name", "").lower()), None)
    setup = next((a for a in rel.get("assets") or [] if a.get("name", "").lower().endswith(".exe")), None)
    if not asset:
        raise RuntimeError("в выпуске нет архива обновления")
    return {"latest": str(rel.get("tag_name") or "").lstrip("vV"), "notes": (rel.get("body") or "").strip()[:2000],
            "url": asset.get("browser_download_url"), "setup_url": setup and setup.get("browser_download_url"),
            "page": rel.get("html_url")}


def check(cfg=None):
    repo = source(cfg)
    cur = current_version()
    if not repo:
        return {"ok": False, "current": cur, "error": "Источник обновлений не настроен (Настройки → «Обновления»)"}
    found, errs = [], []
    for fn in (_branch_info, _release_info):
        try:
            i = fn(repo)
            if i.get("latest") and i.get("url"):
                found.append(i)
        except Exception as e:
            errs.append(str(e))
    if not found:
        return {"ok": False, "current": cur, "repo": repo, "error": f"GitHub не ответил: {errs[0] if errs else 'нет версии'}"}
    best = max(found, key=lambda i: _vt(i["latest"]))
    return {"ok": True, "current": cur, "repo": repo, **best, "available": _vt(best["latest"]) > _vt(cur)}


def download(info, log=print):
    """Скачивает обновление; поставится при перезапуске программы."""
    data = _get(info["url"], timeout=300)
    UPDATE_ZIP.write_bytes(data)
    with zipfile.ZipFile(UPDATE_ZIP) as z:
        names = z.namelist()
        main = next((n for n in names if n.endswith("DoniniPoster/app/main.py")), None)
        if not main:
            raise RuntimeError("в архиве обновления нет программы")
        shutil.rmtree(UPDATE_DIR, ignore_errors=True)
        z.extractall(UPDATE_DIR)
    UPDATE_ZIP.unlink(missing_ok=True)
    # архив из репозитория лежит внутри «DoniniPoster-main/…» — переносим папку программы наверх
    src = UPDATE_DIR / main[: -len("/app/main.py")]
    if src != UPDATE_DIR / "DoniniPoster":
        tmp = UPDATE_DIR.parent / "_update_src"
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.move(str(src), str(tmp))
        shutil.rmtree(UPDATE_DIR, ignore_errors=True)
        UPDATE_DIR.mkdir(parents=True)
        shutil.move(str(tmp), str(UPDATE_DIR / "DoniniPoster"))
    log(f"⬆ Обновление {info.get('latest')} скачано — ставлю при перезапуске")
    return True


def apply_pending():
    """Вызывается при запуске, пока программа ещё не работает: кладёт новые файлы поверх старых."""
    src = UPDATE_DIR / "DoniniPoster"
    if not src.is_dir():
        shutil.rmtree(UPDATE_DIR, ignore_errors=True)
        return False
    for f in src.rglob("*"):
        rel = f.relative_to(src)
        if not f.is_file() or rel.parts[0] in KEEP or "__pycache__" in rel.parts:
            continue
        t = C.ROOT / rel
        t.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(f, t)
        except OSError:
            pass
    # новые сценарии сайтов — только тех сайтов, которых у пользователя ещё нет
    sites = src / "data" / "sites"
    if sites.is_dir():
        for f in sites.glob("*.json"):
            t = C.DATA / "sites" / f.name
            if not t.exists():
                t.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, t)
    shutil.rmtree(UPDATE_DIR, ignore_errors=True)
    return True
