"""Бренд товара по названию папки в очереди (и описанию поставщика, если есть описание.txt).

Например «GUCCI 古奇单肩包 … 26.5x17x7» -> «Gucci», «LV OnTheGo 托特包 35x30» -> «Louis Vuitton».
"""
import re
from pathlib import Path

# каноническое название -> как его пишут поставщики (латиница и китайские названия)
BRANDS = [
    ("Louis Vuitton", ["louis vuitton", "louis vuutton", "louis vuiton", "lv", "路易威登", "驴牌"]),
    ("Gucci", ["gucci", "古奇", "古驰", "酷奇"]),
    ("Dior", ["dior", "迪奥"]),
    ("Coach", ["coach", "蔻驰"]),
    ("Prada", ["prada", "普拉达"]),
    ("Hermes", ["hermès", "hermes", "爱马仕"]),
    ("Michael Kors", ["michael kors", "mk", "迈克高仕"]),
    ("Miu Miu", ["miu miu", "miumiu", "缪缪"]),
    ("Burberry", ["burberry", "巴宝莉", "博柏利"]),
    ("Chanel", ["chanel", "香奈儿"]),
    ("Balenciaga", ["balenciaga", "巴黎世家"]),
    ("Bottega Veneta", ["bottega veneta", "bottega", "bv", "葆蝶家"]),
    ("Fendi", ["fendi", "芬迪"]),
    ("Givenchy", ["givenchy", "纪梵希"]),
    ("Saint Laurent", ["saint laurent", "ysl", "圣罗兰"]),
    ("Valentino", ["valentino", "华伦天奴"]),
    ("Versace", ["versace", "范思哲"]),
    ("Loewe", ["loewe", "罗意威"]),
    ("Celine", ["celine", "céline", "赛琳"]),
    ("Goyard", ["goyard", "戈雅"]),
    ("Montblanc", ["montblanc", "万宝龙"]),
    ("Tumi", ["tumi", "途明"]),
    ("Armani", ["armani", "阿玛尼"]),
    ("Hugo Boss", ["hugo boss", "boss"]),
    ("Calvin Klein", ["calvin klein", "ck"]),
    ("Tory Burch", ["tory burch", "汤丽柏琦"]),
    ("Longchamp", ["longchamp", "珑骧"]),
    ("Moncler", ["moncler", "蒙口"]),
    ("Canada Goose", ["canada goose", "加拿大鹅"]),
    ("The North Face", ["the north face", "north face", "北面"]),
    ("Philipp Plein", ["philipp plein"]),
    ("Dolce & Gabbana", ["dolce & gabbana", "dolce gabbana", "d&g", "杜嘉班纳"]),
    ("Alexander McQueen", ["alexander mcqueen", "mcqueen", "麦昆"]),
    ("Off-White", ["off-white", "off white"]),
    ("Supreme", ["supreme"]),
]


def _is_cjk(s):
    return any("一" <= ch <= "鿿" for ch in s)


def detect_brand(*texts):
    """Первый найденный бренд (по самому раннему упоминанию в тексте)."""
    for text in texts:
        if not text:
            continue
        low = str(text).lower()
        best = None
        for canon, aliases in BRANDS:
            for a in aliases:
                if _is_cjk(a):
                    i = low.find(a)
                else:
                    # латиница — только целым словом (чтобы «mk» не находилось внутри других слов)
                    m = re.search(r"(?<![a-z])" + re.escape(a) + r"(?![a-z])", low)
                    i = m.start() if m else -1
                if i >= 0 and (best is None or i < best[0]):
                    best = (i, canon)
        if best:
            return best[1]
    return ""


def brand_of_product(product):
    """Бренд по названию папки товара; если там нет — по описанию поставщика (описание.txt)."""
    if (product.get("brand") or "").strip():  # бренд поправили вручную в карточке товара
        return product["brand"].strip()
    name = product.get("name") or ""
    b = detect_brand(name)
    if b:
        return b
    try:
        f = Path(product.get("folder") or "") / "описание.txt"
        if f.exists():
            return detect_brand(f.read_text("utf-8", errors="ignore")[:600])
    except Exception:
        pass
    return ""
