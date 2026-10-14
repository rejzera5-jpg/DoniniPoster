"""Уведомления в Telegram через вашего бота (создаётся бесплатно в @BotFather)."""
import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request


def _ssl_contexts():
    import ssl
    yield None  # обычная проверка сертификатов (сертификаты Windows)
    try:
        import certifi  # если в комплекте есть свежий список сертификатов
        yield ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass


def _call(token, method, params=None):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params or {}).encode()
    last = None
    for ctx in _ssl_contexts():
        try:
            with urllib.request.urlopen(url, data=data, timeout=20, context=ctx) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            # Telegram ответил ошибкой — берём его объяснение («Unauthorized», «chat not found» …)
            try:
                desc = json.loads(e.read().decode()).get("description") or str(e)
            except Exception:
                desc = str(e)
            raise RuntimeError(_human(desc)) from None
        except Exception as e:
            last = e
            if "CERTIFICATE" not in str(e).upper():
                break
    raise RuntimeError(f"нет связи с Telegram ({last}). Проверьте интернет; если Telegram у вас открывается только через VPN — включите VPN")


def _human(desc):
    d = desc.lower()
    if "unauthorized" in d or "not found" in d and "chat" not in d:
        return "неверный токен бота — скопируйте его заново из сообщения @BotFather"
    if "chat not found" in d:
        return "chat id не найден — напишите своему боту /start и нажмите «Найти chat id»"
    if "blocked" in d:
        return "вы заблокировали бота — разблокируйте его в Telegram и напишите /start"
    return desc


def send_raw(token, chat_id, text):
    """Отправка с понятной ошибкой (для кнопки «Проверить»)."""
    _call(token, "sendMessage", {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"})


async def send(cfg, text):
    tg = cfg.get("telegram") or {}
    if not tg.get("token") or not tg.get("chat_id"):
        return False
    try:
        await asyncio.to_thread(_call, tg["token"], "sendMessage",
                                {"chat_id": tg["chat_id"], "text": text, "disable_web_page_preview": "true"})
        return True
    except Exception:
        return False


async def find_chat_id(token):
    """Берёт chat id из последнего сообщения, которое вы написали боту (/start)."""
    res = await asyncio.to_thread(_call, token, "getUpdates")
    for upd in reversed(res.get("result", [])):
        msg = upd.get("message") or upd.get("channel_post") or {}
        chat = msg.get("chat") or {}
        if chat.get("id"):
            return str(chat["id"])
    return None
