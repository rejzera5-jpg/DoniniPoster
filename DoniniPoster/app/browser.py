"""Отдельный Chrome программы (свой профиль, вход на сайты запоминается).

Работает в фоне: окно свёрнуто и не мешает. Разворачивается само, только когда
нужна капча, вход на сайт или запись сценария.
"""
import asyncio
import os

from playwright.async_api import async_playwright

from . import config as C

BG_ARGS = [
    # чтобы свёрнутое окно не «засыпало» и продолжало работать в фоне
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
]


def find_yandex():
    """Ищет установленный Яндекс Браузер (он на движке Chromium, как Chrome)."""
    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Yandex\YandexBrowser\Application\browser.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), r"Yandex\YandexBrowser\Application\browser.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), r"Yandex\YandexBrowser\Application\browser.exe"),
    ]
    return next((p for p in candidates if p and os.path.exists(p)), None)


def parse_proxy(text):
    """'socks5://host:port' или 'http://логин:пароль@host:port' -> настройки прокси для браузера."""
    from urllib.parse import urlparse
    text = (text or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "http://" + text
    u = urlparse(text)
    if not u.hostname or not u.port:
        return None
    px = {"server": f"{u.scheme}://{u.hostname}:{u.port}"}
    if u.username:
        px["username"] = u.username
        px["password"] = u.password or ""
    return px


class Browser:
    def __init__(self, log=print):
        self.log = log
        self._pw = None
        self.ctx = None
        self._lock = asyncio.Lock()
        self.pinned = False  # True — окно открыто для вас (запись/вход/тест), не сворачивать
        self.proxy = ""      # строка прокси из настроек (необязательно)

    async def get(self, channel="chrome"):
        async with self._lock:
            if self.ctx is not None:
                try:
                    _ = self.ctx.pages
                    return self.ctx
                except Exception:
                    self.ctx = None
            if self._pw is None:
                self._pw = await async_playwright().start()
            # у каждого браузера свой профиль (входы на сайты), чтобы они не мешали друг другу
            profile = C.PROFILE_DIR if channel == "chrome" else C.DATA / f"profile-{channel or 'chromium'}"
            profile.mkdir(parents=True, exist_ok=True)
            kwargs = dict(user_data_dir=str(profile), headless=os.environ.get("DP_HEADLESS") == "1", args=BG_ARGS,
                          viewport=None, accept_downloads=False,
                          # разрешаем расширения (например VPN) — их можно поставить в окне программы
                          ignore_default_args=["--disable-extensions", "--disable-component-extensions-with-background-pages"])
            px = parse_proxy(self.proxy)
            if px:
                kwargs["proxy"] = px
                self.log(f"Браузер работает через прокси {px['server']}")
            try:
                if channel == "yandex":
                    path = find_yandex()
                    if not path:
                        raise RuntimeError("Яндекс Браузер не найден")
                    self.ctx = await self._pw.chromium.launch_persistent_context(executable_path=path, **kwargs)
                    self.log("Запущен Яндекс Браузер")
                elif channel:
                    self.ctx = await self._pw.chromium.launch_persistent_context(channel=channel, **kwargs)
                else:
                    raise RuntimeError("no channel")
            except Exception as e:
                if channel:
                    self.log(f"Выбранный браузер не запустился ({e}), запускаю встроенный Chromium")
                self.ctx = await self._pw.chromium.launch_persistent_context(**kwargs)
            self.ctx.on("close", lambda *_: setattr(self, "ctx", None))
            return self.ctx

    async def new_page(self, channel="chrome"):
        try:
            return await self._new_page(channel)
        except Exception:
            # окно браузера программы закрыли вручную — открываем заново
            self.ctx = None
            return await self._new_page(channel)

    async def _new_page(self, channel="chrome"):
        ctx = await self.get(channel)
        # переиспользуем пустую стартовую вкладку
        for p in ctx.pages:
            if p.url in ("about:blank", "chrome://newtab/") and not getattr(p, "_dp_used", False):
                p._dp_used = True
                return p
        page = await ctx.new_page()
        page._dp_used = True
        return page

    async def _window(self, page, state):
        try:
            cdp = await page.context.new_cdp_session(page)
            win = await cdp.send("Browser.getWindowForTarget")
            if state == "normal":
                # из minimized сначала в normal, потом на передний план
                await cdp.send("Browser.setWindowBounds", {"windowId": win["windowId"], "bounds": {"windowState": "normal"}})
                await page.bring_to_front()
            else:
                await cdp.send("Browser.setWindowBounds", {"windowId": win["windowId"], "bounds": {"windowState": state}})
            await cdp.detach()
        except Exception:
            pass

    async def show(self, page):
        """Показать окно (капча, вход, запись)."""
        await self._window(page, "normal")

    async def hide(self, page, force=False):
        """Свернуть окно — работа идёт в фоне. Не сворачивает, пока вы работаете в окне (запись, вход)."""
        if self.pinned and not force:
            return
        await self._window(page, "minimized")

    async def hide_all(self):
        self.pinned = False
        if self.ctx:
            for p in self.ctx.pages:
                await self._window(p, "minimized")

    async def close(self):
        try:
            if self.ctx:
                await self.ctx.close()
        finally:
            self.ctx = None
            if self._pw:
                await self._pw.stop()
                self._pw = None
