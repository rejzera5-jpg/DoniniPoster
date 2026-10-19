"""Бренд товара по фото — через ИИ (Claude), если поставщик не написал бренд в описании.

Ключ Claude API вводится в «Настройки» программы (берётся на console.anthropic.com → API Keys).
На одно фото уходит доля цента. Фото уменьшается до 768 px, отправляется только оно — без текста и данных магазина.
"""
import base64
import io
import json
import urllib.request
from pathlib import Path

from .brands import BRANDS

MODEL = "claude-haiku-4-5-20251001"
API = "https://api.anthropic.com/v1/messages"
NAMES = [b for b, _ in BRANDS]


def _jpeg(path, side=768):
    from PIL import Image
    im = Image.open(path)
    im.load()
    im = im.convert("RGB")
    im.thumbnail((side, side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def brand_from_photos(cfg, paths, log=None):
    """Бренд по 1–3 фото товара или "" (не понял / нет ключа / нет связи)."""
    key = (cfg.get("ai_key") or "").strip()
    if not key or not cfg.get("ai_brand", True):
        return ""
    imgs = []
    for p in list(paths)[:3]:
        try:
            imgs.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _jpeg(p)}})
        except Exception:
            continue
    if not imgs:
        return ""
    prompt = ("These photos show one fashion product (bag, wallet, phone case, scarf, accessory). "
              "Which luxury brand is it, judging by logos, monogram patterns and design? "
              f"Answer with exactly one name from this list, or NONE if you are not sure: {', '.join(NAMES)}.")
    body = {"model": MODEL, "max_tokens": 20, "messages": [{"role": "user", "content": imgs + [{"type": "text", "text": prompt}]}]}
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST", headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            out = json.loads(r.read().decode())
    except Exception as e:
        if log:
            msg = str(e)
            if "401" in msg:
                msg = "ключ Claude API не подходит — проверьте его в «Настройки»"
            elif "402" in msg or "credit" in msg.lower():
                msg = "на счёте Claude API закончились деньги"
            log(f"🤖 Бренд по фото: {msg}")
        return ""
    text = "".join(c.get("text", "") for c in out.get("content", []) if c.get("type") == "text").strip()
    low = text.lower()
    for name in NAMES:
        if name.lower() in low:
            return name
    return ""
