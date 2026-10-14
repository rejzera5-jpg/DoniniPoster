"""Очередь товаров: папки с фото -> товары с кодами, размером, ценой и статусами по сайтам.

Как называть папку (всё необязательно):
    26x16            -> размер «26*16 cm»   (x латинская, х русская или ×)
    21x14 26x16      -> размер «21*14\\26*16 cm»
    699zl / 699зл    -> цена 699 зл (иначе берётся цена по умолчанию линии)
    #83300           -> принудительно задать код
Любые другие слова в названии игнорируются.
Можно положить в папку файл info.txt со строками «размер: ...», «цена: ...».
ZIP-архив в папке линии распаковывается автоматически.
"""
import hashlib
import os
import re
import shutil
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from . import config as C

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)(?:\s*[xх×*]\s*(\d+(?:[.,]\d+)?))?", re.I)
PRICE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:zl|zł|зл|pln)\b", re.I)
CODE_RE = re.compile(r"#\s*(\d{2,})")
STABLE_SECONDS = 5  # папка должна не меняться столько секунд (чтобы не взять недокачанную)


def _touched(p):
    """Когда файл последний раз менялся или появился здесь. При копировании Windows сохраняет старую дату
    изменения, поэтому учитываем и время создания (= когда файл скопировали в папку)."""
    st = p.stat()
    return max(st.st_mtime, st.st_ctime)
_warned = set()


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def parse_name(name):
    out = {}
    m = CODE_RE.search(name)
    if m:
        out["code"] = m.group(1)
        name = name.replace(m.group(0), " ")
    m = PRICE_RE.search(name)
    if m:
        out["price"] = float(m.group(1).replace(",", "."))
        name = name.replace(m.group(0), " ")
    sizes = []
    for m in SIZE_RE.finditer(name):
        parts = [p for p in m.groups() if p]
        sizes.append("*".join(parts))
    if sizes:
        out["size"] = "\\".join(sizes) + " cm"
    return out


def parse_info_file(folder):
    f = folder / "info.txt"
    out = {}
    if not f.exists():
        return out
    for line in f.read_text("utf-8", errors="ignore").splitlines():
        if ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        k = k.lower()
        if k in ("размер", "size", "rozmiar") and v:
            out["size"] = v
        elif k in ("цена", "price", "cena") and v:
            try:
                out["price"] = float(v.replace(",", ".").split()[0])
            except ValueError:
                pass
        elif k in ("код", "code") and v:
            out["code"] = v
    return out


def list_photos(folder):
    files = [p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in IMG_EXT
             and not p.name.startswith(".")]
    return [str(p) for p in sorted(files, key=lambda p: natural_key(p.relative_to(folder)))]


def _folder_mtime(folder):
    latest = _touched(folder)
    for p in folder.rglob("*"):
        try:
            latest = max(latest, _touched(p))
        except OSError:
            pass
    return latest


def _pid(path):
    return hashlib.md5(str(path).encode("utf-8")).hexdigest()[:12]


def next_code(cfg, line):
    if cfg.get("shared_counter", True):
        cfg["code_counter"] = int(cfg.get("code_counter", 0)) + 1
        return str(cfg["code_counter"])
    line["counter"] = int(line.get("counter", 0)) + 1
    return str(line["counter"])


def _extract_zips(line_dir):
    for z in line_dir.glob("*.zip"):
        target = line_dir / z.stem
        try:
            if time.time() - _touched(z) < STABLE_SECONDS:
                continue
            with zipfile.ZipFile(z) as zf:
                zf.extractall(target)
            z.unlink()
        except Exception:
            continue


GROUP_RE = re.compile(r"^(.+?)[ _\-]+\(?(\d{1,3})\)?$")
TIME_GAP_MIN = 10  # пауза между снимками больше 10 минут = следующий товар


def _exif_time(path):
    try:
        from PIL import Image
        with Image.open(path) as im:
            ex = im.getexif()
            raw = ex.get_ifd(0x8769).get(36867) or ex.get(306)
        return datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S") if raw else None
    except Exception:
        return None


def split_groups(files):
    """Делит фото на товары: сначала по названию (Товар_040626_01, Товар_040626_02 … Товар_995198_01),
    если не вышло — по времени съёмки (перерыв больше 10 минут). Возвращает [(ключ, [файлы])]."""
    files = sorted(files, key=lambda p: natural_key(p.name))
    groups = {}
    for f in files:
        m = GROUP_RE.match(f.stem)
        groups.setdefault(m.group(1).strip() if m else "", []).append(f)
    named = [k for k in groups if k]
    if len(named) >= 2:
        if "" in groups:  # файлы без номера — к самой большой группе
            biggest = max(named, key=lambda k: len(groups[k]))
            groups[biggest] += groups.pop("")
        return [(k, groups[k]) for k in groups]
    times = [(f, _exif_time(f)) for f in files]
    if len(files) >= 2 and all(t for _, t in times):
        times.sort(key=lambda x: x[1])
        out, cur = [], [times[0][0]]
        for (f, t), (_, prev) in zip(times[1:], times[:-1]):
            if (t - prev).total_seconds() > TIME_GAP_MIN * 60:
                out.append(cur)
                cur = []
            cur.append(f)
        out.append(cur)
        if len(out) >= 2:
            return [(f"{i:02d}", g) for i, g in enumerate(out, 1)]
    return [("", files)]


def _make_product_folders(line_dir, files, base_name, log):
    """Раскладывает фото по папкам товаров. Возвращает число созданных папок."""
    import os as _os
    groups = split_groups(files)
    made = 0
    for key, group in groups:
        name = " - ".join(x for x in (base_name, key) if x) or f"товар {datetime.now():%Y-%m-%d %H-%M-%S}"
        name = re.sub(r'[<>:"/\\|?*]', "_", name)[:120]
        target, i = line_dir / name, 2
        while target.exists() and any(target.iterdir()):
            target, i = line_dir / f"{name} ({i})", i + 1
        target.mkdir(exist_ok=True)
        for f in group:
            shutil.move(str(f), str(target / f.name))
        old = time.time() - STABLE_SECONDS - 1
        _os.utime(target, (old, old))
        made += 1
    return made, len(groups)


KEEP_DIR = C.DATA / "photos"


def keep_photos(p):
    """Своя копия фото товара в программе (data\\photos\\<id>): папку в «Очереди» можно удалить или
    перенести — товар всё равно выставится. На том же диске это «жёсткая ссылка»: места не занимает."""
    if p.get("kept") or not p.get("photos"):
        return False
    dst = KEEP_DIR / p["id"]
    dst.mkdir(parents=True, exist_ok=True)
    kept, kmap = [], {}
    for i, src in enumerate(p["photos"], 1):
        s = Path(src)
        t = dst / f"{i:02d}{s.suffix.lower() or '.jpg'}"
        try:
            if not t.exists():
                try:
                    os.link(s, t)
                except OSError:
                    shutil.copy2(s, t)
            kept.append(str(t))
            kmap[str(src)] = str(t)
        except OSError:
            continue
    if kept:
        p["kept"] = kept
        p["kept_map"] = kmap
        return True
    return False


def restore_kept(p):
    """Папку товара удалили — дальше работаем с копией фото программы."""
    if p.get("kept") and not Path(p.get("folder") or "").is_dir():
        km = p.get("kept_map") or {}
        # порядок и выбор фото из карточки товара сохраняем и для копии
        alive = [km[x] for x in p.get("photos") or [] if x in km and Path(km[x]).exists()] if p.get("photos_locked") else []
        alive = alive or [x for x in p["kept"] if Path(x).exists()]
        if alive and p.get("photos") != alive:
            p["photos"] = alive
            return True
    return False


def scan(cfg, state, log=print):
    """Находит новые папки товаров и добавляет их в очередь. Возвращает True, если что-то изменилось."""
    changed = False
    cfg_changed = False
    root = Path(cfg["queue_root"])
    known_paths = {p["folder"] for p in state["products"].values()}
    # подсказка: товар положили прямо в «Очередь», а не в папку линии
    line_folders = {l["folder"] for l in cfg["lines"]}
    if root.exists():
        for d in root.iterdir():
            stray = (d.is_dir() and d.name not in line_folders) or (d.is_file() and d.suffix.lower() in IMG_EXT)
            if stray and str(d) not in _warned:
                _warned.add(str(d))
                log(f"⚠️ «{d.name}» лежит прямо в папке «Очередь». Переложите в папку линии, например «Очередь\\{cfg['lines'][0]['folder']}\\»")
    for line in cfg["lines"]:
        line_dir = root / line["folder"]
        if not line_dir.exists():
            line_dir.mkdir(parents=True, exist_ok=True)
            continue
        _extract_zips(line_dir)
        # фото положили прямо в папку линии (без своей папки) — собираем их в папку товара
        loose = [p for p in line_dir.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXT]
        if loose and time.time() - line_dir.stat().st_mtime > STABLE_SECONDS and all(time.time() - _touched(p) > STABLE_SECONDS for p in loose):
            made, _ = _make_product_folders(line_dir, loose, "", log)
            log(f"Фото лежали прямо в «{line['folder']}» — разложил по товарам: {made} шт.")
        folders =[d for d in line_dir.iterdir() if d.is_dir() and not d.name.startswith(("_", "."))]
        folders.sort(key=lambda d: (d.stat().st_ctime, natural_key(d.name)))
        for d in folders:
            if str(d) in known_paths:
                continue
            # «.ready» кладёт скачивание из WeChat, когда все фото уже на месте — тогда ждать не нужно
            if not (d / ".ready").exists() and time.time() - _folder_mtime(d) < STABLE_SECONDS:
                continue  # ещё качается
            photos = list_photos(d)
            if not photos:
                continue
            # в одной папке несколько товаров (разные названия или время съёмки) — делим
            top = [Path(p) for p in photos if Path(p).parent == d]
            if len(top) == len(photos) and len(split_groups(top)) >= 2:
                made, _ = _make_product_folders(line_dir, top, d.name, log)
                log(f"В папке «{d.name}» нашлось несколько товаров — разделил на {made} папок")
                try:
                    if not any(d.iterdir()):
                        d.rmdir()
                except OSError:
                    pass
                continue
            info = {**parse_name(d.name), **parse_info_file(d)}
            code = info.get("code") or next_code(cfg, line)
            cfg_changed = True
            pid = _pid(d)
            state["products"][pid] = {
                "id": pid, "line": line["id"], "folder": str(d), "name": d.name, "code": code,
                "size": info.get("size") or line.get("default_size", ""),
                "price": info.get("price") if info.get("price") is not None else (line.get("default_price") or 0),
                "photos": photos, "added": datetime.now().isoformat(timespec="seconds"),
                "sites": {sid: {"status": "pending"} for sid in line.get("sites", [])},
                "status": "queued",
            }
            keep_photos(state["products"][pid])
            log(f"Новый товар {code}: «{d.name}», фото: {len(photos)}")
            changed = True
    # товары в очереди без своей копии фото (добавлены до этой версии) — делаем копию; папку удалили — берём копию
    for p in state["products"].values():
        if p.get("status") == "archived":
            continue
        if not p.get("kept") and Path(p.get("folder") or "").is_dir():
            if keep_photos(p):
                changed = True
        elif p.get("kept") and not p.get("kept_map") and len(p["kept"]) == len(p.get("photos") or []) \
                and Path(p.get("folder") or "").is_dir():
            p["kept_map"] = dict(zip(p["photos"], p["kept"]))
            changed = True
        if restore_kept(p):
            changed = True
    if cfg_changed:
        C.save_config(cfg)
    return changed


def sync_sites(cfg, state, log=print):
    """Если в «Линии товара» добавили/убрали сайт — обновляем товары, которые ещё в очереди."""
    lines = {l["id"]: l for l in cfg["lines"]}
    changed = False
    reopened = {}
    for p in state["products"].values():
        if p["line"] not in lines:
            continue
        want = lines[p["line"]].get("sites", [])
        if p["status"] == "archived":
            # в линию добавили НОВЫЙ сайт, а папка товара ещё лежит в очереди —
            # товар снова идёт в работу, но только на новый сайт (на старых он уже выставлен)
            new = [sid for sid in want if sid not in p["sites"]]
            if new and (Path(p.get("folder") or "").is_dir() or any(Path(x).exists() for x in p.get("kept") or [])):
                for sid in new:
                    p["sites"][sid] = {"status": "pending"}
                    reopened[sid] = reopened.get(sid, 0) + 1
                p["status"] = "queued"
                p.pop("archived_at", None)
                changed = True
            continue
        for sid in want:
            if sid not in p["sites"]:
                p["sites"][sid] = {"status": "pending"}
                changed = True
        for sid in list(p["sites"]):
            if sid not in want and p["sites"][sid].get("status") == "pending":
                del p["sites"][sid]
                changed = True
    for sid, n in reopened.items():
        log(f"➕ Сайт {sid} добавлен в линию — {n} уже выставленных товаров из очереди пойдут и на него")
    if changed and not reopened:
        log("Сайты у товаров в очереди обновлены по настройкам «Линии товара»")
    return changed


def product_finished(p):
    return all(s["status"] in ("done", "skipped") for s in p["sites"].values())


def archive_finished(cfg, state, log=print):
    """Переносит полностью выставленные товары в папку «Выставлено/<дата>»."""
    changed = False
    done_root = Path(cfg["done_root"])
    for p in list(state["products"].values()):
        if p["status"] == "archived" or not product_finished(p):
            continue
        src = Path(p["folder"])
        # По умолчанию папка выставленного товара ОСТАЁТСЯ на месте в «Очереди» — удаляете её вы сами.
        # (Переносить в «Выставлено» — только если в настройках включено move_done_folders.)
        if src.exists() and cfg.get("move_done_folders", False):
            day = done_root / datetime.now().strftime("%Y-%m-%d")
            day.mkdir(parents=True, exist_ok=True)
            dst = day / f"{p['code']} {src.name}"
            i = 2
            while dst.exists():
                dst = day / f"{p['code']} {src.name} ({i})"
                i += 1
            try:
                shutil.move(str(src), str(dst))
                p["folder"] = str(dst)
            except Exception as e:
                log(f"Не удалось перенести папку {src}: {e}")
                continue
        p["status"] = "archived"
        p["archived_at"] = datetime.now().isoformat(timespec="seconds")
        shutil.rmtree(C.PREPARED_DIR / p["id"], ignore_errors=True)
        log(f"Товар {p['code']} выставлен везде" + (" — перенесён в «Выставлено»" if cfg.get("move_done_folders", False)
                                                    else " — папка оставлена в «Очереди»"))
        changed = True
    return changed


def cleanup_old(cfg, state, log=print):
    days = int(cfg.get("delete_done_after_days", 0) or 0)
    if days <= 0:
        return False
    cutoff = datetime.now() - timedelta(days=days)
    changed = False
    done_root = Path(cfg["done_root"])
    if done_root.exists():
        for day in done_root.iterdir():
            try:
                d = datetime.strptime(day.name, "%Y-%m-%d")
            except ValueError:
                continue
            if day.is_dir() and d < cutoff:
                shutil.rmtree(day, ignore_errors=True)
                log(f"Удалены старые фото за {day.name}")
    if KEEP_DIR.exists():
        for d in KEEP_DIR.iterdir():
            p = state["products"].get(d.name)
            old = p and p.get("status") == "archived" and p.get("archived_at") and datetime.fromisoformat(p["archived_at"]) < cutoff
            if not p or old:
                shutil.rmtree(d, ignore_errors=True)
                if p:
                    p.pop("kept", None)
                changed = True
    for pid, p in list(state["products"].items()):
        if p["status"] == "archived" and p.get("archived_at"):
            if datetime.fromisoformat(p["archived_at"]) < cutoff - timedelta(days=30):
                if Path(p.get("folder") or "").exists():
                    continue  # папка ещё лежит в очереди — запись нужна, иначе товар попадёт в очередь снова
                del state["products"][pid]  # историю храним ещё месяц
                changed = True
    return changed


def set_line(p, line):
    """Перенести товар в другой вид товара: другой шаблон текста и свои сайты (уже выставленное не трогаем)."""
    p["line"] = line["id"]
    want = line.get("sites", [])
    for sid in want:
        if sid not in p["sites"]:
            p["sites"][sid] = {"status": "pending"}
    for sid in list(p["sites"]):
        if sid not in want and p["sites"][sid].get("status") in ("pending", "error"):
            del p["sites"][sid]
    if p.get("status") == "archived" and any(st.get("status") == "pending" for st in p["sites"].values()):
        p["status"] = "queued"
        p.pop("archived_at", None)
