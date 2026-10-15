"""Проверка фото товара: находит «плохие» снимки, чтобы они не шли в объявления.

Плохое фото:
  • битое / не открывается / обрезано при скачивании (часть картинки серая или пустая);
  • замыленное — резкость сильно ниже, чем у остальных фото этого же товара;
  • слишком маленькое (меньше 400 px по короткой стороне).
Проверка идёт прямо в программе, без интернета. Фото не удаляются — просто не используются в объявлении
(в карточке товара их видно и можно вернуть)."""
import hashlib
from pathlib import Path

from PIL import Image, ImageFile, ImageFilter, ImageStat

MIN_SIDE = 400
# во сколько раз резкость ниже средней по товару, чтобы считать фото замыленным (меньше — строже)
BLUR_RATIO = {"soft": 0.07, "normal": 0.12, "strict": 0.2}
BLUR_ABS = {"soft": 20, "normal": 40, "strict": 80}  # и одновременно ниже этого числа


def _open(path):
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    im = Image.open(path)
    im.load()  # обрезанный при скачивании файл здесь падает: «image file is truncated»
    return im


def _sharpness(gray):
    """Резкость: разброс «краёв» на уменьшенной копии (чем больше — тем чётче)."""
    g = gray.copy()
    g.thumbnail((800, 800))
    edges = g.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128))
    return ImageStat.Stat(edges).var[0]


def _blank_tail(im):
    """Доля картинки снизу (или справа), залитая ровным серым — так выглядит недокачанное фото
    (JPEG дорисовывает недостающее серым 128). Смотрим в полном размере: у настоящего фона
    (белого, серого, чёрного) всегда есть «шум» камеры, у заливки — нет."""
    rgb = im.convert("RGB")
    w, h = rgb.size
    worst = 0.0
    for horizontal in (True, False):
        n = h if horizontal else w
        step = max(1, n // 300)
        run = total = 0
        for i in range(n - 1, -1, -step):
            box = (0, i, w, i + 1) if horizontal else (i, 0, i + 1, h)
            st = ImageStat.Stat(rgb.crop(box))
            mean, sd = st.mean, max(st.stddev)
            grayish = 112 <= min(mean) and max(mean) <= 144 and max(mean) - min(mean) < 6
            if not ((grayish and sd < 1.2) or sd < 0.25):
                break
            run += 1
        total = (n + step - 1) // step
        worst = max(worst, run / total)
    return worst


QC_VER = 2


def check_one(path):
    """{ok, reason, sharp} для одного фото."""
    try:
        im = _open(path)
    except Exception as e:
        if "truncat" not in str(e).lower():
            return {"ok": False, "reason": "фото битое — не открывается", "sharp": 0}
        # «не хватает конца файла» бывает и у нормальных фото (с сайтов, из WeChat) — браузер их показывает целиком.
        # Плохим считаем, только если реально видно пустую/серую часть картинки (проверка ниже).
        try:
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            im = Image.open(path)
            im.load()
        except Exception:
            return {"ok": False, "reason": "фото битое — не открывается", "sharp": 0}
        finally:
            ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        if min(im.size) < MIN_SIDE:
            return {"ok": False, "reason": f"слишком маленькое ({im.size[0]}×{im.size[1]})", "sharp": 0}
        tail = _blank_tail(im)
        if tail >= 0.12:
            return {"ok": False, "reason": f"части фото нет (~{int(tail * 100)}% пустое)", "sharp": 0}
        return {"ok": True, "reason": "", "sharp": _sharpness(im.convert("L"))}
    finally:
        try:
            im.close()
        except Exception:
            pass


def _digest(path):
    try:
        return hashlib.md5(Path(path).read_bytes()).hexdigest()
    except OSError:
        return path


def check_product(paths, level="normal"):
    """Плохие фото товара: {путь: причина}. Хотя бы одно фото всегда остаётся (самое резкое)."""
    dup, seen = {}, {}
    for p in paths:  # одно и то же фото два раза (на сайте главное фото часто повторяется в галерее)
        h = _digest(p)
        if h in seen:
            dup[p] = "повтор — такое же фото уже есть"
        else:
            seen[h] = p
    paths = [p for p in paths if p not in dup]
    res = {p: check_one(p) for p in paths}
    good = [p for p, r in res.items() if r["ok"]]
    bad = {p: r["reason"] for p, r in res.items() if not r["ok"]}
    if len(good) >= 3:
        vals = sorted(res[p]["sharp"] for p in good)
        med = vals[len(vals) // 2]
        for p in good:
            s = res[p]["sharp"]
            r = BLUR_RATIO.get(level, 0.12)
            # сильно мягче остальных фото товара — или заметно мягче и при этом совсем без деталей
            if s < med * r * 0.45 or (s < med * r and s < BLUR_ABS.get(level, 40)):
                bad[p] = "замыленное"
    if len(bad) >= len(paths) and paths:
        # всё «плохое» — оставляем лучшее, чтобы товар не остался без фото
        best = max(paths, key=lambda p: res[p]["sharp"])
        bad.pop(best, None)
    return {**dup, **bad}


def pending(p, cfg):
    """Товар ещё ждёт проверки фото — на доски его пока не отдаём (максимум 10 минут)."""
    if (cfg.get("photo_qc") or "normal") == "off" or p.get("qc_done") or p.get("photos_locked"):
        return False
    from datetime import datetime
    try:
        return (datetime.now() - datetime.fromisoformat(p.get("added"))).total_seconds() < 600
    except Exception:
        return False


def loop(engine):
    """Фоновая проверка: новые товары в очереди — сразу после появления."""
    import time
    time.sleep(8)
    while True:
        try:
            level = engine.cfg.get("photo_qc") or "normal"
            if not getattr(engine, "_qc_fixed", False):
                engine._qc_fixed = True
                n = restore_wrong(engine)
                if n:
                    engine.log(f"♻️ Вернул фото, ошибочно убранные проверкой («фото обрезано»): товаров {n} — проверяю их заново")
                    engine.save()
            todo = [] if level == "off" else [p for p in list(engine.state["products"].values())
                                               if p.get("status") != "archived" and not p.get("qc_done")]
            for p in todo[:20]:
                if p.get("photos_locked"):  # фото вы выбрали сами — не трогаем
                    p["qc_done"] = True
                    continue
                bad = run_for_product(p, level)
                if bad:
                    why = {}
                    for r in bad.values():
                        k = r.split(" (")[0].split(" —")[0]
                        why[k] = why.get(k, 0) + 1
                    engine.log(f"🧹 Товар {p.get('code')}: убрал плохие фото — {len(bad)} ({', '.join(f'{k}: {v}' for k, v in why.items())}), осталось {len(p['photos'])}")
            if todo:
                engine.save()
        except Exception as e:
            try:
                engine.log(f"⚠️ Проверка фото: {e}")
            except Exception:
                pass
        time.sleep(4)


def restore_wrong(engine):
    """Версия 4.3.0 ошибочно убирала нормальные фото как «обрезанные» — возвращаем все фото и проверяем заново."""
    from . import queue_store
    n = 0
    for p in engine.state["products"].values():
        bad = p.get("qc_bad") or {}
        if p.get("qc_ver") == QC_VER or not any("обрезано" in str(v) for v in bad.values()):
            continue
        f = Path(p.get("folder") or "")
        allp = queue_store.list_photos(f) if f.is_dir() else [x for x in p.get("kept") or [] if Path(x).exists()]
        if allp:
            p["photos"] = allp
        p.pop("photos_locked", None)
        p.pop("qc_bad", None)
        p.pop("qc_done", None)
        n += 1
    return n


def run_for_product(p, level="normal"):
    """Проверяет фото товара в очереди. Плохие убираются из объявления (файлы остаются в папке,
    в карточке товара их видно с причиной — можно вернуть). Возвращает {путь: причина}."""
    photos = [x for x in p.get("photos") or [] if Path(x).exists()]
    if not photos:
        p["qc_done"] = True
        return {}
    bad = check_product(photos, level)
    p["qc_done"] = True
    p["qc_ver"] = QC_VER
    p["qc_bad"] = bad
    if bad:
        p["photos"] = [x for x in photos if x not in bad]
        p["photos_locked"] = True
    return bad
