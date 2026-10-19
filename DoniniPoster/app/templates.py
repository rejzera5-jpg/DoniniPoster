"""Шаблоны текстов — перенесены один в один из Donini Manager.

Название = заголовок шаблона + " " + код.
Описание = тело шаблона с подставленным размером.
Цена вводится в злотых и пересчитывается в валюту страны с «шармовым»
округлением вверх (...9, для CZK ...90, для HUF ...990) — как в Donini.
"""
import base64
import json
import math
import urllib.parse

# ---- Сумки (основной шаблон Donini) ----
BAGS = {
    "HU": {"title": lambda b: f"{b} Márkás női táska, Bőr, Franciaország" if b else "Márkás női táska, Bőr, Franciaország",
           "body": lambda s: f"méretek: {s}\nanyag: valódi bőr\nA szett tartalmaz egy márkás dobozt, porvédőt és dokumentumokat\n\nA fotók valódiak!\n\nA minőség kiváló!\n\nAjándéknak is tökéletes!!!\n\nSzállítás 2–4 héten belül"},
    "DE": {"title": lambda b: f"Damenhandtasche aus Leder {b}" if b else "Damenhandtasche aus Leder",
           "body": lambda s: f"Größe: {s}\nMaterial: echtes Leder\nIm Lieferumfang enthalten: originale Markenbox, Staubbeutel und Dokumente.\nLieferzeit: ca. 14 Tage.\nHervorragende Qualität.\nFotos vom tatsächlichen Produkt!\n\nZahlung per Nachnahme oder per Banküberweisung.\nIdeal als Geschenk!"},
    "PT": {"title": lambda b: f"Bolsa feminina em couro {b}" if b else "Bolsa feminina em couro",
           "body": lambda s: f"Tamanho: {s}\nMaterial: couro genuíno\nInclui: caixa original da marca, saco protetor contra o pó e documentos.\nPrazo de entrega: aproximadamente 14 dias.\nQualidade excelente.\nFotos do produto real!\nPagamento à cobrança ou por transferência bancária.\nIdeal para oferecer como presente!"},
    "ES": {"title": lambda b: f"Bolso de mano {b}" if b else "Bolso de mano",
           "body": lambda s: f"Tamaño: {s}\nMaterial: Piel auténtica\nIncluye caja de la marca y documentación\nEntrega: Aprox. 4-5 días\nExcelente calidad\n¡Foto real!\n\nEnvío a cualquier país."},
    "NL": {"title": lambda b: f"Dameshandtas van leer {b}" if b else "Dameshandtas van leer",
           "body": lambda s: f"Afmetingen: {s}\nMateriaal: echt leer\nInclusief: originele merkdoos, stofzak en documentatie.\nLevertijd: ongeveer 14 dagen.\nUitstekende kwaliteit.\nFoto's van het echte product!\n\nBetaling onder rembours of via bankoverschrijving.\nIdeaal als cadeau!"},
    "PL": {"title": lambda b: f"Torebka damska skórzana {b}" if b else "Torebka damska skórzana",
           "body": lambda s: f"Rozmiar: {s}\nMateriał: skóra naturalna\nW zestawie: oryginalne pudełko marki, worek na kurz i dokumenty.\nCzas dostawy: ok. 14 dni.\nDoskonała jakość.\nZdjęcia rzeczywistego produktu!\n\nPłatność za pobraniem lub przelewem.\nIdealny prezent!"},
    "RO": {"title": lambda b: f"Geantă de damă din piele {b}" if b else "Geantă de damă din piele",
           "body": lambda s: f"Dimensiuni: {s}\nMaterial: piele naturală\nInclude: cutie originală a mărcii, husă de praf și documente.\nTermen de livrare: aprox. 14 zile.\nCalitate excelentă.\nFotografii reale ale produsului!\n\nPlata ramburs sau prin transfer bancar.\nIdeal ca cadou!"},
    "HR": {"title": lambda b: f"Ženska kožna torbica {b}" if b else "Ženska kožna torbica",
           "body": lambda s: f"Veličina: {s}\nMaterijal: prava koža\nUključeno: originalna kutija marke, vrećica za prašinu i dokumenti.\nRok isporuke: oko 14 dana.\nOdlična kvaliteta.\nStvarne fotografije proizvoda!\n\nPlaćanje pouzećem ili bankovnim transferom.\nIdealno za poklon!"},
    "CZ": {"title": lambda b: f"Dámská kožená kabelka {b}" if b else "Dámská kožená kabelka",
           "body": lambda s: f"Velikost: {s}\nMateriál: pravá kůže\nSoučástí balení: originální krabička značky, prachový sáček a dokumenty.\nDoba dodání: cca 14 dní.\nVynikající kvalita.\nSkutečné fotografie produktu!\n\nPlatba na dobírku nebo bankovním převodem.\nIdeální jako dárek!"},
    "GR": {"title": lambda b: f"Γυναικεία δερμάτινη τσάντα {b}" if b else "Γυναικεία δερμάτινη τσάντα",
           "body": lambda s: f"Μέγεθος: {s}\nΥλικό: γνήσιο δέρμα\nΠεριλαμβάνει: αυθεντικό κουτί της μάρκας, σακουλάκι προστασίας από τη σκόνη και έγγραφα.\nΧρόνος παράδοσης: περίπου 14 ημέρες.\nΕξαιρετική ποιότητα.\nΠραγματικές φωτογραφίες του προϊόντος!\n\nΠληρωμή με αντικαταβολή ή με τραπεζική μεταφορά.\nΙδανικό για δώρο!"},
}
# Австрия пишет по-немецки, Бельгия (2dehands.be) — по-нидерландски: тексты те же, что у DE и NL
BAGS["AT"] = BAGS["DE"]
BAGS["BE"] = BAGS["NL"]
# для своих шаблонов: если для страны текст ещё не написан — берём текст этой страны
LANG_FALLBACK = {"AT": "DE", "BE": "NL"}

LANG_NAMES = {"HU": "Венгрия", "DE": "Германия", "PT": "Португалия", "ES": "Испания", "NL": "Нидерланды",
              "PL": "Польша", "RO": "Румыния", "HR": "Хорватия", "CZ": "Чехия",
              "AT": "Австрия", "GR": "Греция", "BE": "Бельгия"}
ALL_LANGS = list(LANG_NAMES)

BODY_BUILDERS = {
    "HU": lambda s, m: f"méretek: {s}\nanyag: {m}\nA szett tartalmaz egy márkás dobozt, porvédőt és dokumentumokat\n\nA fotók valódiak!\n\nA minőség kiváló!\n\nAjándéknak is tökéletes!!!\n\nSzállítás 2–4 héten belül",
    "DE": lambda s, m: f"Größe: {s}\nMaterial: {m}\nIm Lieferumfang enthalten: originale Markenbox, Staubbeutel und Dokumente.\nLieferzeit: ca. 14 Tage.\nHervorragende Qualität.\nFotos vom tatsächlichen Produkt!\n\nZahlung per Nachnahme oder per Banküberweisung.\nIdeal als Geschenk!",
    "PT": lambda s, m: f"Tamanho: {s}\nMaterial: {m}\nInclui: caixa original da marca, saco protetor contra o pó e documentos.\nPrazo de entrega: aproximadamente 14 dias.\nQualidade excelente.\nFotos do produto real!\nPagamento à cobrança ou por transferência bancária.\nIdeal para oferecer como presente!",
    "ES": lambda s, m: f"Tamaño: {s}\nMaterial: {m}\nIncluye caja de la marca y documentación\nEntrega: Aprox. 4-5 días\nExcelente calidad\n¡Foto real!\n\nEnvío a cualquier país.",
    "NL": lambda s, m: f"Afmetingen: {s}\nMateriaal: {m}\nInclusief: originele merkdoos, stofzak en documentatie.\nLevertijd: ongeveer 14 dagen.\nUitstekende kwaliteit.\nFoto's van het echte product!\n\nBetaling onder rembours of via bankoverschrijving.\nIdeaal als cadeau!",
    "PL": lambda s, m: f"Rozmiar: {s}\nMateriał: {m}\nW zestawie: oryginalne pudełko marki, worek na kurz i dokumenty.\nCzas dostawy: ok. 14 dni.\nDoskonała jakość.\nZdjęcia rzeczywistego produktu!\n\nPłatność za pobraniem lub przelewem.\nIdealny prezent!",
    "RO": lambda s, m: f"Dimensiuni: {s}\nMaterial: {m}\nInclude: cutie originală a mărcii, husă de praf și documente.\nTermen de livrare: aprox. 14 zile.\nCalitate excelentă.\nFotografii reale ale produsului!\n\nPlata ramburs sau prin transfer bancar.\nIdeal ca cadou!",
    "HR": lambda s, m: f"Veličina: {s}\nMaterijal: {m}\nUključeno: originalna kutija marke, vrećica za prašinu i dokumenti.\nRok isporuke: oko 14 dana.\nOdlična kvaliteta.\nStvarne fotografije proizvoda!\n\nPlaćanje pouzećem ili bankovnim transferom.\nIdealno za poklon!",
    "CZ": lambda s, m: f"Velikost: {s}\nMateriál: {m}\nSoučástí balení: originální krabička značky, prachový sáček a dokumenty.\nDoba dodání: cca 14 dní.\nVynikající kvalita.\nSkutečné fotografie produktu!\n\nPlatba na dobírku nebo bankovním převodem.\nIdeální jako dárek!",
    "GR": lambda s, m: f"Μέγεθος: {s}\nΥλικό: {m}\nΠεριλαμβάνει: αυθεντικό κουτί της μάρκας, σακουλάκι προστασίας από τη σκόνη και έγγραφα.\nΧρόνος παράδοσης: περίπου 14 ημέρες.\nΕξαιρετική ποιότητα.\nΠραγματικές φωτογραφίες του προϊόντος!\n\nΠληρωμή με αντικαταβολή ή με τραπεζική μεταφορά.\nΙδανικό για δώρο!",
}
BODY_BUILDERS["AT"] = BODY_BUILDERS["DE"]
BODY_BUILDERS["BE"] = BODY_BUILDERS["NL"]

MATERIALS = {
    "leather": {"HU": "valódi bőr", "DE": "echtes Leder", "PT": "couro genuíno", "ES": "Piel auténtica", "NL": "echt leer", "PL": "skóra naturalna", "RO": "piele naturală", "HR": "prava koža", "CZ": "pravá kůže"},
    "wool": {"HU": "valódi gyapjú", "DE": "echte Wolle", "PT": "lã genuína", "ES": "Lana auténtica", "NL": "echte wol", "PL": "wełna naturalna", "RO": "lână naturală", "HR": "prava vuna", "CZ": "pravá vlna"},
    "silk": {"HU": "valódi selyem", "DE": "echte Seide", "PT": "seda genuína", "ES": "Seda auténtica", "NL": "echte zijde", "PL": "jedwab naturalny", "RO": "mătase naturală", "HR": "prava svila", "CZ": "pravé hedvábí"},
    "quality": {"HU": "kiváló minőségű anyag", "DE": "hochwertiges Material", "PT": "material de alta qualidade", "ES": "Material de alta calidad", "NL": "hoogwaardig materiaal", "PL": "materiał wysokiej jakości", "RO": "material de calitate superioară", "HR": "kvalitetan materijal", "CZ": "kvalitní materiál"},
    "down": {"HU": "valódi pehely", "DE": "echte Daunen", "PT": "penugem genuína", "ES": "Plumón auténtico", "NL": "echt dons", "PL": "prawdziwy puch", "RO": "puf natural", "HR": "prirodno perje", "CZ": "pravé peří"},
}

_GR_MAT = {"leather": "γνήσιο δέρμα", "wool": "γνήσιο μαλλί", "silk": "γνήσιο μετάξι",
           "quality": "υψηλής ποιότητας υλικό", "down": "φυσικό πούπουλο"}
for _k, _v in MATERIALS.items():
    _v["GR"] = _GR_MAT[_k]
    _v["AT"] = _v["DE"]
    _v["BE"] = _v["NL"]

TYPE_NOUNS = {
    "wallets": {"HU": ("pénztárca", "Bőr"), "DE": ("Geldbörse", "Leder"), "PT": ("Carteira", "couro"), "ES": ("Cartera", None), "NL": ("Portemonnee", "leer"), "PL": ("Portfel skórzany", None), "RO": ("Portofel", "piele"), "HR": ("Kožni novčanik", None), "CZ": ("Kožená peněženka", None)},
    "belts": {"HU": ("öv", "Bőr"), "DE": ("Gürtel", "Leder"), "PT": ("Cinto", "couro"), "ES": ("Cinturón", None), "NL": ("Riem", "leer"), "PL": ("Pasek skórzany", None), "RO": ("Curea", "piele"), "HR": ("Kožni remen", None), "CZ": ("Kožený pásek", None)},
    "hats": {"HU": ("sapka", "Gyapjú"), "DE": ("Mütze", "Wolle"), "PT": ("Gorro", "lã"), "ES": ("Gorro", None), "NL": ("Muts", "wol"), "PL": ("Czapka wełniana", None), "RO": ("Căciulă", "lână"), "HR": ("Vunena kapa", None), "CZ": ("Vlněná čepice", None)},
    "scarves": {"HU": ("sál", "Selyem"), "DE": ("Schal", "Seide"), "PT": ("Cachecol", "seda"), "ES": ("Bufanda", None), "NL": ("Sjaal", "zijde"), "PL": ("Szalik jedwabny", None), "RO": ("Eșarfă", "mătase"), "HR": ("Svilena marama", None), "CZ": ("Hedvábný šátek", None)},
    "sportbags": {"HU": ("sporttáska", "Minőségi anyag"), "DE": ("Sporttasche", "hochwertigem Material"), "PT": ("Mala de desporto", "material de alta qualidade"), "ES": ("Bolsa deportiva", None), "NL": ("Sporttas", "hoogwaardig materiaal"), "PL": ("Torba sportowa", None), "RO": ("Geantă sport", "material de calitate superioară"), "HR": ("Sportska torba", None), "CZ": ("Sportovní taška", None)},
    "ties": {"HU": ("nyakkendő", "Selyem"), "DE": ("Krawatte", "Seide"), "PT": ("Gravata", "seda"), "ES": ("Corbata", None), "NL": ("Stropdas", "zijde"), "PL": ("Krawat jedwabny", None), "RO": ("Cravată", "mătase"), "HR": ("Svilena kravata", None), "CZ": ("Hedvábná kravata", None)},
    "shoes": {"HU": ("cipő", "Bőr"), "DE": ("Schuhe", "Leder"), "PT": ("Sapatos", "couro"), "ES": ("Zapatos", None), "NL": ("Schoenen", "leer"), "PL": ("Buty skórzane", None), "RO": ("Pantofi", "piele"), "HR": ("Kožne cipele", None), "CZ": ("Kožené boty", None)},
    "swimsuits": {"HU": ("fürdőruha", "Minőségi anyag"), "DE": ("Badeanzug", "hochwertigem Material"), "PT": ("Fato de banho", "material de alta qualidade"), "ES": ("Bañador", None), "NL": ("Badpak", "hoogwaardig materiaal"), "PL": ("Strój kąpielowy", None), "RO": ("Costum de baie", "material de calitate superioară"), "HR": ("Kupaći kostim", None), "CZ": ("Plavky", None)},
    "downjackets": {"HU": ("kabát", "Pehely"), "DE": ("Jacke", "Daunen"), "PT": ("Casaco", "penugem"), "ES": ("Chaqueta", None), "NL": ("Jas", "dons"), "PL": ("Kurtka puchowa", None), "RO": ("Geacă", "puf"), "HR": ("Perjana jakna", None), "CZ": ("Péřová bunda", None)},
    "caps": {"HU": ("baseballsapka", "Minőségi anyag"), "DE": ("Baseballcap", "hochwertigem Material"), "PT": ("Boné", "material de alta qualidade"), "ES": ("Gorra", None), "NL": ("Pet", "hoogwaardig materiaal"), "PL": ("Czapka z daszkiem", None), "RO": ("Șapcă", "material de calitate superioară"), "HR": ("Kapa s vizirom", None), "CZ": ("Kšiltovka", None)},
}
_GR_NOUNS = {"wallets": "Δερμάτινο πορτοφόλι", "belts": "Δερμάτινη ζώνη", "hats": "Μάλλινος σκούφος",
             "scarves": "Μεταξωτό φουλάρι", "sportbags": "Αθλητική τσάντα", "ties": "Μεταξωτή γραβάτα",
             "shoes": "Δερμάτινα παπούτσια", "swimsuits": "Μαγιό", "downjackets": "Πουπουλένιο μπουφάν",
             "caps": "Καπέλο τζόκεϊ"}
for _k, _v in TYPE_NOUNS.items():
    _v["GR"] = (_GR_NOUNS[_k], None)
    _v["AT"] = _v["DE"]
    _v["BE"] = _v["NL"]

TYPE_MATERIAL_KEY = {"wallets": "leather", "belts": "leather", "hats": "wool", "scarves": "silk", "sportbags": "quality",
                     "ties": "silk", "shoes": "leather", "swimsuits": "quality", "downjackets": "down", "caps": "quality"}
TYPE_LABELS = {"bags": "Сумки", "wallets": "Кошельки", "belts": "Ремни", "hats": "Шапки", "scarves": "Шарфы",
               "sportbags": "Спортивные сумки", "ties": "Галстуки", "shoes": "Обувь", "swimsuits": "Купальники",
               "downjackets": "Пуховики", "caps": "Кепки"}


def _title_fn(code, noun, mat):
    def wrap(base):
        return lambda b: f"{base} {b}" if b else base
    if code == "HU":
        return lambda b: f"{b} Márkás {noun}, {mat}, Franciaország" if b else f"Márkás {noun}, {mat}, Franciaország"
    if code in ("DE", "AT"):
        return wrap(f"{noun} aus {mat}")
    if code == "PT":
        return wrap(f"{noun} em {mat}")
    if code in ("NL", "BE"):
        return wrap(f"{noun} van {mat}")
    if code == "RO":
        return wrap(f"{noun} din {mat}")
    return wrap(noun)


def _build_type(type_id):
    nouns = TYPE_NOUNS[type_id]
    material = MATERIALS[TYPE_MATERIAL_KEY[type_id]]
    out = {}
    for code in ALL_LANGS:
        noun, mat = nouns[code]
        out[code] = {"title": _title_fn(code, noun, mat),
                     "body": (lambda c: lambda s: BODY_BUILDERS[c](s, material[c]))(code)}
    return out


BUILT_IN = {"bags": BAGS}
for _t in TYPE_NOUNS:
    BUILT_IN[_t] = _build_type(_t)

# ---- Чехлы для телефонов: вместо размера — модель телефона («iPhone 18 Pro Max») ----
# Модель берётся из описания поставщика (18promax, 苹果18 Pro, 16/17/18 ProMax…) и стоит в поле «размер» товара.
import re as _re_ph
re = _re_ph
SUF = r"(pro\s*max|promax|p\s*max|pm|pro|plus|max|mini|air|e)?"
PHONE_RE = re.compile(r"(?:(iphone|苹果|苹果手机|ip|i)\s*)?(?<![\d.])(6|7|8|1[0-9]|20|x[rs]?|se)\s*" + SUF + r"(?![\d*xX×.])", re.I)

def norm(num, suf):
    num = num.upper() if num.lower().startswith("x") else num
    if num.lower() == "se": num = "SE"
    s = (suf or "").lower().replace(" ", "")
    s = {"promax": " Pro Max", "pmax": " Pro Max", "pm": " Pro Max", "pro": " Pro", "plus": " Plus", "max": " Max", "mini": " mini", "air": " Air", "e": "e"}.get(s, "")
    return f"iPhone {num}{s}"

LIST_RE = re.compile(r"(?<![\d.])((?:1[0-9]|20)(?:\s*[/、,，|]\s*(?:1[0-9]|20))+)\s*" + SUF + r"(?![\d*xX×.])", re.I)

_SKIP_LINE = re.compile(r"定制|无做|不做|没有|不退|系列")


def parse_phone_models(text):
    # строки «需定制型号（15/14…）» (под заказ), «无做14plus» (нет), «iPhone18系列更新» (заголовок) — не модели в наличии
    lines = [ln for ln in (text or "").splitlines() if not _SKIP_LINE.search(ln)]
    text = "\n".join(lines)
    out = []
    for m in LIST_RE.finditer(text or ""):
        for n in re.findall(r"\d+", m.group(1)):
            v = norm(n, m.group(2))
            if v not in out:
                out.append(v)
    text = LIST_RE.sub(" ", text or "")
    for m in PHONE_RE.finditer(text or ""):
        pre, num, suf = m.groups()
        if not pre and not suf:
            continue  # голое число — это может быть цена/размер
        if pre and pre.lower() == "i" and not suf:
            continue
        v = norm(num, suf)
        if v not in out:
            out.append(v)
    return out



def phone_models_text(text):
    """«iPhone 18 Pro Max, 18 Pro, 18, 17 Pro Max» — компактно для описания."""
    return compact_models(parse_phone_models(text))


def compact_models(models):
    out = []
    for i, m in enumerate(models):
        out.append(m if i == 0 else m.replace("iPhone ", "", 1))
    return ", ".join(out)


def short_models(model_text):
    """Для названия: одна модель — целиком («iPhone 18 Pro Max»), несколько — поколения («iPhone 18 / 17 / 16»)."""
    t = (model_text or "").strip()
    if not t or ("," not in t and "/" not in t):
        return t
    nums = []
    for part in re.split(r"[,/]", t):
        m = re.match(r"\s*(?:iPhone\s*)?(\d{1,2}|XR|XS|X|SE)\b", part.strip(), re.I)
        if m:
            n = m.group(1).upper()
            if n not in nums:
                nums.append(n)
    return "iPhone " + " / ".join(nums) if nums else t


def _case(m_title, plain, label, body_rest):
    return {"title_m": lambda b, m: " ".join(x for x in ((m_title.format(m=m) if m else plain), b) if x),
            "title": lambda b: " ".join(x for x in (plain, b) if x),
            "body": lambda m: f"{label}: {m}\n{body_rest}"}


PHONECASES = {
    "HU": {"title_m": lambda b, m: " ".join(x for x in (b, "Márkás telefontok", m) if x),
           "title": lambda b: f"{b} Márkás telefontok".strip(),
           "body": lambda m: f"Telefon típusa: {m}\nAnyag: kiváló minőségű anyag\nPontosan illeszkedik, védi a telefont az ütésektől és karcolásoktól\n\nA fotók valódiak!\n\nA minőség kiváló!\n\nAjándéknak is tökéletes!!!\n\nSzállítás 2–4 héten belül"},
    "DE": _case("Handyhülle {m}", "Handyhülle", "Passend für", "Material: hochwertiges Material\nPasst perfekt und schützt das Handy vor Stößen und Kratzern.\nLieferzeit: ca. 14 Tage.\nHervorragende Qualität.\nFotos vom tatsächlichen Produkt!\n\nZahlung per Nachnahme oder per Banküberweisung.\nIdeal als Geschenk!"),
    "PT": _case("Capa para {m}", "Capa para telemóvel", "Compatível com", "Material: material de alta qualidade\nAjuste perfeito, protege o telemóvel contra quedas e riscos.\nPrazo de entrega: aproximadamente 14 dias.\nQualidade excelente.\nFotos do produto real!\nPagamento à cobrança ou por transferência bancária.\nIdeal para oferecer como presente!"),
    "ES": _case("Funda {m}", "Funda de móvil", "Compatible con", "Material: alta calidad\nAjuste perfecto, protege el móvil de golpes y arañazos\nEntrega: Aprox. 4-5 días\nExcelente calidad\n¡Foto real!\n\nEnvío a cualquier país."),
    "NL": _case("Telefoonhoesje {m}", "Telefoonhoesje", "Geschikt voor", "Materiaal: hoogwaardig materiaal\nPast perfect en beschermt de telefoon tegen stoten en krassen.\nLevertijd: ongeveer 14 dagen.\nUitstekende kwaliteit.\nFoto's van het echte product!\n\nBetaling onder rembours of via bankoverschrijving.\nIdeaal als cadeau!"),
    "PL": _case("Etui {m}", "Etui na telefon", "Model telefonu", "Materiał: wysokiej jakości\nIdealnie dopasowane, chroni telefon przed uderzeniami i zarysowaniami.\nCzas dostawy: ok. 14 dni.\nDoskonała jakość.\nZdjęcia rzeczywistego produktu!\n\nPłatność za pobraniem lub przelewem.\nIdealny prezent!"),
    "RO": _case("Husă {m}", "Husă telefon", "Compatibil cu", "Material: de calitate superioară\nSe potrivește perfect și protejează telefonul de lovituri și zgârieturi.\nTermen de livrare: aprox. 14 zile.\nCalitate excelentă.\nFotografii reale ale produsului!\n\nPlata ramburs sau prin transfer bancar.\nIdeal ca cadou!"),
    "HR": _case("Maska za {m}", "Maska za mobitel", "Za model", "Materijal: kvalitetan materijal\nSavršeno pristaje i štiti mobitel od udaraca i ogrebotina.\nRok isporuke: oko 14 dana.\nOdlična kvaliteta.\nStvarne fotografije proizvoda!\n\nPlaćanje pouzećem ili bankovnim transferom.\nIdealno za poklon!"),
    "CZ": _case("Pouzdro na {m}", "Pouzdro na mobil", "Pro model", "Materiál: kvalitní materiál\nPerfektně sedí a chrání telefon před nárazy a poškrábáním.\nDoba dodání: cca 14 dní.\nVynikající kvalita.\nSkutečné fotografie produktu!\n\nPlatba na dobírku nebo bankovním převodem.\nIdeální jako dárek!"),
    "GR": _case("Θήκη κινητού {m}", "Θήκη κινητού", "Συμβατό με", "Υλικό: υψηλής ποιότητας υλικό\nΤέλεια εφαρμογή, προστατεύει το κινητό από χτυπήματα και γρατζουνιές.\nΧρόνος παράδοσης: περίπου 14 ημέρες.\nΕξαιρετική ποιότητα.\nΠραγματικές φωτογραφίες του προϊόντος!\n\nΠληρωμή με αντικαταβολή ή με τραπεζική μεταφορά.\nΙδανικό για δώρο!"),
}
PHONECASES["AT"] = PHONECASES["DE"]
PHONECASES["BE"] = PHONECASES["NL"]
BUILT_IN["phonecases"] = PHONECASES
TYPE_LABELS["phonecases"] = "Чехлы"

# ---- Валюты (снимок курсов как в Donini, можно поменять в настройках) ----
DEFAULT_RATES = {"EUR": 0.228504, "HUF": 84.103327, "RON": 1.210063, "CZK": 5.589892}
LANG_CURRENCY = {"HU": "HUF", "DE": "EUR", "PT": "EUR", "ES": "EUR", "NL": "EUR", "PL": "PLN", "RO": "RON", "HR": "EUR", "CZ": "CZK",
                 "AT": "EUR", "GR": "EUR", "BE": "EUR"}


def round_charm(value, currency):
    if not math.isfinite(value) or value <= 0:
        return value
    if currency == "HUF":
        step, offset = 1000, 10
    elif currency == "CZK":
        step, offset = 100, 10
    else:
        step, offset = 10, 1
    rounded = math.ceil((value + offset) / step) * step - offset
    if rounded <= 0:
        rounded = step - offset
    return int(rounded)


def convert_price(pln, lang, rates=None, currency=None):
    """Цена в злотых -> (число, валюта) для страны. None если цены нет.
    currency — своя валюта сайта (например EUR на румынском Publi24), иначе валюта страны."""
    if pln is None or pln <= 0:
        return None
    rates = rates or DEFAULT_RATES
    cur = (currency or "").upper() or LANG_CURRENCY.get(lang, "PLN")
    rate = 1 if cur == "PLN" else rates.get(cur)
    if not rate:
        return None
    return round_charm(pln * rate, cur), cur


# ---- Свои шаблоны (импорт кода «PLT-ШАБЛОНЫ-1:» из Donini) ----
TEMPLATE_EXPORT_PREFIX = "PLT-ШАБЛОНЫ-1:"


def decode_donini_code(text):
    text = text.strip()
    if not text.startswith(TEMPLATE_EXPORT_PREFIX):
        raise ValueError("Это не код шаблонов Donini (должен начинаться с PLT-ШАБЛОНЫ-1:)")
    raw = base64.b64decode(text[len(TEMPLATE_EXPORT_PREFIX):].strip())
    # Donini кодирует как btoa(unescape(encodeURIComponent(json))) -> это просто UTF-8 байты
    data = json.loads(raw.decode("utf-8"))
    return [ct for ct in data if isinstance(ct, dict) and ct.get("id") and ct.get("label") and ct.get("langs")]


SIZE_LINE_RE = __import__("re").compile(
    r"^(\s*(?:méretek|méret|Größe|Grösse|Tamanho|Tamaño|Afmetingen|Rozmiar|Wymiary|Dimensiuni|Veličina|Velikost|Rozměry|Μέγεθος|Size|Размер|Telefon típusa|Passend für|Compatível com|Compatible con|Geschikt voor|Model telefonu|Compatibil cu|Za model|Pro model|Συμβατό με|Модель)\s*:\s*).*$",
    __import__("re").IGNORECASE | __import__("re").MULTILINE)


# вся строка с размером (без захвата следующей строки) — убирается, когда размера у товара нет
SIZE_LINE_DROP_RE = __import__("re").compile(
    r"^[ \t]*(?:méretek|méret|Größe|Grösse|Tamanho|Tamaño|Afmetingen|Rozmiar|Wymiary|Dimensiuni|Veličina|Velikost|Rozměry|Μέγεθος|Size|Размер|Telefon típusa|Passend für|Compatível com|Compatible con|Geschikt voor|Model telefonu|Compatibil cu|Za model|Pro model|Συμβατό με|Модель)[ \t]*:[^\n]*(?:\n|$)",
    __import__("re").IGNORECASE | __import__("re").MULTILINE)


def list_types(custom):
    items = [{"id": k, "label": TYPE_LABELS.get(k, k), "custom": False} for k in BUILT_IN]
    items += [{"id": c["id"], "label": c["label"], "custom": True} for c in custom]
    return items


# ---- правки из карточек Donini Manager (кнопка «↺ Авто» там) ----
# Расширение Donini само забирает их из открытого Donini Manager и кладёт в data/manager_overrides.json.
# Как и в самом Manager, правка заменяет текст шаблона для этой страны; код и размер подставляются свои.
_OV = {"mtime": None, "data": {}}


def _manager_overrides():
    from pathlib import Path
    f = Path(__file__).resolve().parent.parent / "data" / "manager_overrides.json"
    try:
        m = f.stat().st_mtime
    except OSError:
        return {}
    if _OV["mtime"] != m:
        try:
            _OV["data"] = json.loads(f.read_text(encoding="utf-8")) or {}
        except Exception:
            _OV["data"] = {}
        _OV["mtime"] = m
    return _OV["data"]


def _apply_overrides(type_id, lang, size, code, brand, title, body):
    ov = _manager_overrides()
    key = f"{type_id}:{lang}"
    t = (ov.get("titleOverrides") or {}).get(key)
    b = (ov.get("bodyOverrides") or {}).get(key)
    fb = LANG_FALLBACK.get(lang)
    if fb and t is None:  # Австрия/Бельгия без своей правки — как правка Германии/Нидерландов
        t = (ov.get("titleOverrides") or {}).get(f"{type_id}:{fb}")
    if fb and b is None:
        b = (ov.get("bodyOverrides") or {}).get(f"{type_id}:{fb}")
    if isinstance(t, dict) and not (t.get("text") or "").strip() and (t.get("base") or "").strip():
        # новый формат Donini Manager: {"base": "Muška torba", "brand": ""} — только сам текст, без кода
        base = t["base"].strip()
        title = f"{base} {brand}".strip() if brand else base
        if code:
            title = f"{title} {code}"
        return title, (b, True)
    if isinstance(t, dict) and (t.get("text") or "").strip():
        text = t["text"]
        old_code, old_brand = str(t.get("code") or ""), str(t.get("brand") or "")
        if old_brand and old_brand != (brand or ""):
            text = text.replace(old_brand, brand or "")
        if old_code and old_code in text:
            text = text.replace(old_code, str(code or ""))
        elif code:
            text = f"{text.rstrip()} {code}"
        title = " ".join(text.split()) if not code else text.strip()
        return title, (b, True)
    return title, (b, False)


def build_texts(type_id, lang, size, code, brand="", custom=None):
    """Возвращает (название, описание) ровно как в Donini Manager (с его правками в карточках)."""
    title, body = _build_texts_base(type_id, lang, size, code, brand, custom)
    title, (b, _) = _apply_overrides(type_id, lang, size, code, brand, title, body)
    if isinstance(b, dict) and ((b.get("text") or "").strip() or (b.get("base") or "").strip()):
        text = b.get("text") or b.get("base")
        old_size = str(b.get("size") or "")
        if size:
            if SIZE_LINE_RE.search(text):  # строка «Размер: …» — меняем только её
                text = SIZE_LINE_RE.sub(lambda m: m.group(1) + size, text, count=1)
            elif len(old_size) >= 3 and old_size in text:
                text = text.replace(old_size, size)
        body = text
    if type_id == "phonecases":
        title = _case_title_model(title, short_models(size), code)
    if not (size or "").strip():
        # размера нет — строку «Rozmiar: …» убираем совсем (иначе в объявлении остался бы размер из шаблона)
        body = SIZE_LINE_DROP_RE.sub("", body).lstrip("\n")
    return title, body


def _build_texts_base(type_id, lang, size, code, brand="", custom=None):
    custom = custom or []
    if type_id in BUILT_IN:
        t = BUILT_IN[type_id][lang]
        title = t["title_m"](brand, short_models(size)) if "title_m" in t else t["title"](brand)
        body = t["body"](size)
    else:
        ct = next((c for c in custom if c["id"] == type_id), None)
        if not ct:
            raise KeyError(f"Шаблон «{type_id}» не найден")
        saved = ct["langs"].get(lang) or ct["langs"].get(LANG_FALLBACK.get(lang, "")) or {}
        if not (saved.get("title") or saved.get("body")):
            # для этой страны в своём шаблоне текста нет (например, новая Греция) — берём стандартный «Сумки»
            saved = {"title": BAGS[lang]["title"](""), "body": BAGS[lang]["body"](size or "")}
        title = saved.get("title", "")
        body = saved.get("body", "")
        # В своих шаблонах можно писать {size} и {brand} — подставятся автоматически.
        title = title.replace("{brand}", brand or "").strip()
        if "{size}" in body:
            body = body.replace("{size}", size or "")
        elif size:
            # в шаблонах Donini размер «вшит» в строку «Rozmiar: ...» — заменяем его на размер товара
            body = SIZE_LINE_RE.sub(lambda m: m.group(1) + size, body, count=1)
    if code:
        title = f"{title} {code}"
    return title, body


def _case_title_model(title, model, code):
    """Чехлы: в названии должна стоять модель этого товара. Если название поправлено в Donini Manager
    с моделью-примером («Etui iPhone 17 Pro») — модель-пример меняется на модель товара."""
    model = (model or "").strip()
    if not model or model.lower() in (title or "").lower():
        return title
    first = [True]

    def rep(m):
        if first[0]:
            first[0] = False
            return model
        return ""
    t2 = LIST_RE.sub(rep, title) if LIST_RE.search(title) else title
    t2 = PHONE_RE.sub(lambda m: rep(m) if (m.group(1) or m.group(3)) else m.group(0), t2)
    t2 = " ".join(t2.split())
    if model.lower() in t2.lower():
        return t2
    code = str(code or "")
    if code and t2.endswith(code):
        return f"{t2[:-len(code)].strip()} {model} {code}"
    return f"{t2} {model}"
