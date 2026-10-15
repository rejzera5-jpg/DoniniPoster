"""Проверка фото товара: находит «плохие» снимки, чтобы они не шли в объявления.

Плохое фото:
  • битое / не открывается / обрезано при скачивании (часть картинки серая или пустая);
  • недокачанное — файл обрезан (главная причина «замыленных» фото с сайта и WeChat);
  • не в фокусе — по-настоящему размытый снимок;
  • слишком маленькое (меньше 400 px по короткой стороне).
Проверка идёт прямо в программе, без интернета. Фото не удаляются — просто не используются в объявлении
(в карточке товара их видно и можно вернуть)."""
import hashlib
from pathlib import Path

from PIL import Image, ImageFile, ImageFilter, ImageStat

ImageFile.LOAD_TRUNCATED_IMAGES = True

MIN_SIDE = 400
# во сколько раз резкость ниже средней по товару, чтобы считать фото замыленным (меньше — строже)
# замыленное: чёткость ниже ABS — всегда; ниже REL от средней по товару и ниже REL_MAX — тоже
# Замер на 3853 фото сайта (Louis Vuitton): у целых фото чёткость почти всегда 20 и выше,
# по-настоящему «не в фокусе» — 8–15. Порог ниже этого, чтобы не трогать мягкие снимки деталей.
BLUR_ABS = {"soft": 12, "normal": 16, "strict": 20}


def _open(path):
    # общую настройку Pillow НЕ трогаем (её используют миниатюры и подготовка фото в других потоках):
    # фото без конца файла открываются, а недокачанные ловятся по пустой/серой части картинки
    im = Image.open(path)
    im.load()
    return im


def _sharpness(gray):
    """Чёткость: насколько резкие самые чёткие края на фото (строчка, логотип, край коробки).
    Фото приводится к 1024 px, чтобы большие и маленькие фото сравнивались честно.
    У нормального фото такие края есть всегда (≈40 и выше), у замыленного / растянутого из маленького — нет (≈10–30)."""
    from PIL import ImageChops
    g = gray.copy()
    g.thumbnail((1024, 1024))
    lap = g.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128))
    d = ImageChops.difference(lap, Image.new("L", lap.size, 128))
    h = d.histogram()
    n, acc = sum(h), 0
    for v in range(255, -1, -1):
        acc += h[v]
        if acc >= n * 0.005:  # самые резкие 0,5% точек
            return v
    return 0


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


QC_VER = 5


def truncated(path):
    """Файл скачан не до конца. Главная причина «замыленных» фото: у прогрессивного JPEG без конца файла
    картинка остаётся размытой (или пустой). Признак точный — у целого JPEG в конце всегда есть метка FF D9."""
    try:
        with open(path, "rb") as f:
            head = f.read(4)
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 4096))
            tail = f.read()
    except OSError:
        return False
    if head[:2] == b"\xff\xd8":
        return b"\xff\xd9" not in tail
    if head == b"\x89PNG":
        return b"IEND" not in tail
    return False


def check_one(path):
    """{ok, reason, sharp} для одного фото."""
    # Обрезанный файл (например, после неудачной оптимизации на сайте) ещё не значит плохое фото:
    # если оборвались последние «слои», фото выглядит нормально. Судим по тому, как фото выглядит.
    trunc = truncated(path)
    try:
        im = _open(path)
    except Exception:
        return {"ok": False, "reason": "фото битое — не открывается", "sharp": 0}
    try:
        if min(im.size) < MIN_SIDE:
            return {"ok": False, "reason": f"слишком маленькое ({im.size[0]}×{im.size[1]})", "sharp": 0}
        gray = im.convert("L")
        if ImageStat.Stat(gray).stddev[0] < 6:
            return {"ok": False, "reason": "пустое фото — картинки нет" + (" (файл обрезан)" if trunc else ""), "sharp": 0}
        tail = _blank_tail(im)
        if tail >= 0.12:
            return {"ok": False, "reason": f"части фото нет (~{int(tail * 100)}% пустое)", "sharp": 0}
        return {"ok": True, "reason": "", "sharp": _sharpness(gray), "trunc": trunc}
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
    for p in good:
        sh = res[p]["sharp"]
        if sh < BLUR_ABS.get(level, 16):
            bad[p] = (f"размытое — файл обрезан (чёткость {sh})" if res[p].get("trunc")
                      else f"не в фокусе — размытое (чёткость {sh})")
    if len(bad) >= len(paths) and paths:
        # всё «плохое»: если есть хоть одно целое фото — оставляем лучшее из целых; недокачанные не оставляем
        whole = [p for p in paths if res[p]["ok"]]  # открывается целиком (пусть и мягкое)
        if whole:
            best = max(whole, key=lambda p: res[p]["sharp"])
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
                    engine.log(f"🧹 Новая проверка фото: перепроверяю товары в очереди — {n} шт.")
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
        if p.get("status") == "archived" or p.get("qc_ver") == QC_VER or not p.get("qc_done"):
            continue
        if p.get("photos_locked") and not bad:
            continue  # фото выбраны вручную в карточке — не трогаем
        f = Path(p.get("folder") or "")
        allp = queue_store.list_photos(f) if f.is_dir() else [x for x in p.get("kept") or [] if Path(x).exists()]
        if allp:
            p["photos"] = allp
        p.pop("photos_locked", None)
        p.pop("qc_bad", None)
        p.pop("qc_done", None)
        p.pop("qc_allbad", None)
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
    p["qc_allbad"] = len(bad) >= len(photos)
    p["qc_bad"] = bad
    if bad and not p["qc_allbad"]:
        p["photos"] = [x for x in photos if x not in bad]
        p["photos_locked"] = True
    return bad
