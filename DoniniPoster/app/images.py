"""Подготовка фото перед загрузкой: поворот по EXIF, уменьшение, JPEG. Оригиналы не трогаются."""
from pathlib import Path

from PIL import Image, ImageFile, ImageOps

# программы-загрузчики часто сохраняют фото чуть «недокачанными» (не хватает пары байт в конце) —
# такие фото полностью нормальные на вид, просто разрешаем их открывать
ImageFile.LOAD_TRUNCATED_IMAGES = True

from . import config as C


# поддержка HEIC/AVIF, если библиотеки установлены (иначе просто пропускаем)
try:
    import pillow_heif  # noqa
    pillow_heif.register_heif_opener()
except Exception:
    pass

LAST_ERRORS = []  # последние ошибки открытия фото — показываются в журнале


def _open(src):
    """Открывает фото; если антивирус на миг занял файл — повторяет."""
    import time
    for i in range(6):
        try:
            im = Image.open(src)
            im.load()
            return im
        except PermissionError:
            time.sleep(0.3 * (i + 1))
    return Image.open(src)


def prepare(product, max_side=1600, limit=None):
    ImageFile.LOAD_TRUNCATED_IMAGES = True  # фото без конца файла (с сайтов, WeChat) — открываем
    out_dir = C.PREPARED_DIR / product["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    result = []
    # фото могли удалить/добавить в папке уже после того, как товар встал в очередь — берём то, что есть сейчас
    try:
        from .queue_store import list_photos
        folder = Path(product.get("folder") or "")
        if folder.is_dir() and not product.get("photos_locked"):  # фото выбраны вручную в карточке — не трогаем
            fresh = list_photos(folder)
            if fresh:
                product["photos"] = fresh
    except Exception:
        pass
    photos = [p for p in product["photos"] if Path(p).exists()]
    if not photos and product.get("kept"):  # папку товара удалили — берём копию фото программы
        km = product.get("kept_map") or {}
        photos = [km[x] for x in product.get("photos") or [] if x in km and Path(km[x]).exists()] \
            or [p for p in product["kept"] if Path(p).exists()]
    if limit and len(photos) > limit:
        # фото больше, чем принимает сайт: последнее (обычно «вид внутри») важно — оставляем его,
        # а пропускаем те, что перед ним (при 9 фото и лимите 8 пропадёт 8-е)
        photos = photos[:limit - 1] + [photos[-1]] if limit > 1 else photos[:1]
    import hashlib
    for i, src in enumerate(photos, 1):
        try:
            tag = hashlib.md5(f"{src}|{Path(src).stat().st_mtime}".encode("utf-8")).hexdigest()[:6]
        except OSError:
            tag = "x"
        dst = out_dir / f"{product['code']}_{i:02d}_{tag}.jpg"
        if not dst.exists():
            try:
                im = _open(src)
                im = ImageOps.exif_transpose(im)
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                im.thumbnail((max_side, max_side))
                im.save(dst, "JPEG", quality=88, optimize=True)
            except Exception as e:
                LAST_ERRORS.append(f"Не удалось открыть фото {Path(src).name}: {e.__class__.__name__}: {e}")
                continue  # битый/неподдерживаемый файл пропускаем
        result.append(str(dst))
    return result


def sample_photos(n=3):
    """Фото-образцы для записи сценария, если в очереди ещё нет товаров."""
    from PIL import ImageDraw
    out = C.PREPARED_DIR / "_sample"
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(1, n + 1):
        dst = out / f"obrazec_{i}.jpg"
        if not dst.exists():
            im = Image.new("RGB", (1200, 900), (200 - i * 20, 170, 140))
            d = ImageDraw.Draw(im)
            d.rectangle([60, 60, 1140, 840], outline=(90, 60, 40), width=8)
            d.text((520, 430), f"SAMPLE {i}", fill=(60, 40, 30))
            im.save(dst, "JPEG", quality=85)
        paths.append(str(dst))
    return paths


_THUMBS = {}


def thumbnail(src, size=160):
    """Миниатюра в памяти (без записи на диск — антивирус не мешает)."""
    ImageFile.LOAD_TRUNCATED_IMAGES = True  # фото без конца файла (с сайтов, WeChat) — открываем
    import io
    key = (str(src), size)
    if key not in _THUMBS:
        try:
            im = _open(src)
            im = ImageOps.exif_transpose(im)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.thumbnail((size, size))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80)
            _THUMBS[key] = buf.getvalue()
        except Exception as e:
            LAST_ERRORS.append(f"Не удалось открыть фото {Path(src).name}: {e.__class__.__name__}: {e}")
            raise
        if len(_THUMBS) > 500:
            _THUMBS.pop(next(iter(_THUMBS)))
    return _THUMBS[key]
