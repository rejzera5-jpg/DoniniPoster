"""Запуск Donini Poster: движок + веб-интерфейс, работает в фоне."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

import uvicorn

from . import config as C

try:
    APP_VERSION_BASE = (C.ROOT / "app" / "VERSION").read_text("utf-8").strip() or "4.2"
except OSError:
    APP_VERSION_BASE = "4.2"


def _code_fingerprint():
    """Отпечаток файлов программы: если файлы обновили, версия меняется сама,
    и повторный запуск (Запуск.bat / ярлык) перезапускает работающую старую копию."""
    import hashlib
    from pathlib import Path
    h = hashlib.sha1()
    for f in sorted(Path(__file__).parent.glob("*.py")):
        try:
            h.update(f.name.encode()); h.update(f.read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:8]


APP_VERSION = f"{APP_VERSION_BASE}-{_code_fingerprint()}"


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def running_version(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=3) as r:
            return json.loads(r.read().decode()).get("version")
    except Exception:
        return None  # старые версии не умеют отвечать на этот вопрос


def stop_running(port):
    """Останавливает уже запущенную (старую) копию программы."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/quit", data=b"{}",
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass
    for _ in range(30):
        if not port_busy(port):
            return True
        time.sleep(0.5)
    # старая копия не закрылась сама — закрываем принудительно (процесс, который держит порт программы)
    if sys.platform.startswith("win"):
        try:
            out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True,
                                 creationflags=0x08000000, timeout=15).stdout
            pids = {l.split()[-1] for l in out.splitlines() if f"127.0.0.1:{port} " in l and "LISTEN" in l.upper()}
            for pid in pids:
                if pid.isdigit() and int(pid) != os.getpid():
                    subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True, creationflags=0x08000000, timeout=15)
            for _ in range(20):
                if not port_busy(port):
                    return True
                time.sleep(0.5)
        except Exception:
            pass
    return False


def _pythonw():
    p = C.ROOT / "python" / "pythonw.exe"
    if p.exists():
        return str(p)
    exe = sys.executable or "pythonw.exe"
    return exe[:-10] + "pythonw.exe" if exe.lower().endswith("python.exe") else exe


def _shortcut_ps(path_expr, args):
    """PowerShell: создать/обновить ярлык программы (без консоли, со своей иконкой)."""
    ico = C.ROOT / "app" / "web" / "icon.ico"
    q = lambda v: str(v).replace("'", "''")
    return (
        f"$p={path_expr};"
        "$ws=New-Object -ComObject WScript.Shell;$l=$ws.CreateShortcut($p);"
        f"$l.TargetPath='{q(_pythonw())}';$l.Arguments='{q(args)}';$l.WorkingDirectory='{q(C.ROOT)}';"
        f"if(Test-Path '{q(ico)}'){{$l.IconLocation='{q(ico)},0'}};"
        "$l.Description='Donini Poster — выставление товаров';$l.WindowStyle=1;$l.Save()"
    )


def ensure_desktop_shortcut():
    """Ярлык «Donini Poster» на рабочем столе: открывает окно программы (без чёрного окна консоли),
    со своей иконкой. Старый ярлык на Запуск.bat обновляется."""
    if not sys.platform.startswith("win"):
        return
    run = C.ROOT / "run.pyw"
    try:
        _ps(_shortcut_ps("Join-Path ([Environment]::GetFolderPath('Desktop')) 'Donini Poster.lnk'", f'"{run}"'), 30)
    except Exception:
        pass


def _startup_lnk_expr():
    return "Join-Path ([Environment]::GetFolderPath('Startup')) 'Donini Poster.lnk'"


def set_autostart(on):
    """Автозапуск вместе с Windows: программа стартует в фоне (без окна), браузер — сразу с расширением."""
    if not sys.platform.startswith("win"):
        return False
    run = C.ROOT / "run.pyw"
    try:
        if on:
            _ps(_shortcut_ps(_startup_lnk_expr(), f'"{run}" --autostart'), 30)
        else:
            _ps(f"$p={_startup_lnk_expr()}; if(Test-Path $p){{Remove-Item $p -Force}}", 30)
        return True
    except Exception:
        return False


def autostart_state():
    if not sys.platform.startswith("win"):
        return False
    try:
        return "yes" in _ps(f"if(Test-Path ({_startup_lnk_expr()})){{'yes'}}else{{'no'}}", 20)
    except Exception:
        return False


# ---------- браузер пользователя (Яндекс / Chrome) с расширением Donini ----------
BROWSER_FLAGS = [
    # окно выставления может лежать позади других окон — сайты всё равно работают
    "--disable-features=CalculateNativeWinOcclusion,DisableLoadExtensionCommandLineSwitch",
    "--disable-backgrounding-occluded-windows",
]


# Браузеры на движке Chromium (в них работает расширение Donini). Firefox не подходит.
BROWSERS = {
    "yandex":  {"name": "Яндекс Браузер", "proc": "browser.exe", "ua": "YaBrowser", "progid": "yandex",
                "paths": [r"%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe",
                          r"%ProgramFiles%\Yandex\YandexBrowser\Application\browser.exe",
                          r"%ProgramFiles(x86)%\Yandex\YandexBrowser\Application\browser.exe"]},
    "chrome":  {"name": "Google Chrome", "proc": "chrome.exe", "ua": "Chrome", "progid": "chromehtml",
                "paths": [r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
                          r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
                          r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"]},
    "edge":    {"name": "Microsoft Edge", "proc": "msedge.exe", "ua": "Edg/", "progid": "msedgehtm",
                "paths": [r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
                          r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"]},
    "brave":   {"name": "Brave", "proc": "brave.exe", "ua": "Brave", "progid": "bravehtml",
                "paths": [r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe",
                          r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"]},
    "opera":   {"name": "Opera", "proc": "opera.exe", "ua": "OPR/", "progid": "opera",
                "paths": [r"%LOCALAPPDATA%\Programs\Opera\opera.exe", r"%ProgramFiles%\Opera\opera.exe"]},
    "vivaldi": {"name": "Vivaldi", "proc": "vivaldi.exe", "ua": "Vivaldi", "progid": "vivaldi",
                "paths": [r"%LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe"]},
}
ORDER = ["yandex", "chrome", "edge", "brave", "opera", "vivaldi"]


def _exp(p):
    return os.path.expandvars(p)


def _from_registry(key):
    """Путь к браузеру из реестра Windows (App Paths) — если стоит не в обычной папке."""
    try:
        import winreg
        exe = BROWSERS[key]["proc"]
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(root, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}") as k:
                    v = winreg.QueryValue(k, None)
                    if v and os.path.exists(v.strip('"')) and (key != "yandex" or "yandex" in v.lower()):
                        return v.strip('"')
            except OSError:
                continue
    except Exception:
        pass
    return None


_SMI = None


def _start_menu_internet():
    """Все браузеры, зарегистрированные в Windows (Параметры → Приложения по умолчанию): имя → путь к exe."""
    global _SMI
    if _SMI is not None:
        return _SMI
    out = {}
    try:
        import winreg
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for base in (r"Software\Clients\StartMenuInternet", r"Software\WOW6432Node\Clients\StartMenuInternet"):
                try:
                    with winreg.OpenKey(root, base) as k:
                        i = 0
                        while True:
                            try:
                                name = winreg.EnumKey(k, i)
                            except OSError:
                                break
                            i += 1
                            try:
                                with winreg.OpenKey(k, name + r"\shell\open\command") as c:
                                    cmd = str(winreg.QueryValue(c, None) or "")
                                exe = cmd.split('"')[1] if cmd.startswith('"') else cmd.split(" ")[0]
                                if exe and os.path.exists(exe):
                                    out.setdefault(name.lower(), exe)
                            except OSError:
                                continue
                except OSError:
                    continue
    except Exception:
        pass
    _SMI = out
    return out


SMI_NAMES = {"yandex": "yandex", "chrome": "google chrome", "edge": "microsoft edge", "brave": "brave",
             "opera": "opera", "vivaldi": "vivaldi"}


def browser_path(key):
    b = BROWSERS.get(key)
    if not b:
        return None
    for p in b["paths"]:
        p = _exp(p)
        if p and os.path.exists(p):
            return p
    for name, exe in _start_menu_internet().items():  # браузер стоит не в обычной папке
        if SMI_NAMES[key] in name and os.path.basename(exe).lower() == b["proc"]:
            return exe
    if key != "yandex":  # у Яндекса exe называется browser.exe — по App Paths его не отличить
        return _from_registry(key)
    return None


def default_browser_key():
    """Браузер по умолчанию в Windows (тот, что открывает ссылки)."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice") as k:
            prog = str(winreg.QueryValueEx(k, "ProgId")[0]).lower()
        for key in ORDER:
            if BROWSERS[key]["progid"] in prog:
                return key
    except Exception:
        pass
    return None


def installed_browsers():
    return [k for k in ORDER if browser_path(k)]


def pick_browser_key(cfg=None):
    """Какой браузер использовать: выбранный в настройках → тот, где работает расширение Donini (программа видит
    это сама) → браузер по умолчанию в Windows → первый установленный."""
    cfg = cfg or C.load_config()
    for key in (cfg.get("user_browser") if cfg.get("user_browser") not in (None, "", "auto") else None,
                cfg.get("_ext_browser"), default_browser_key()):
        if key in BROWSERS and browser_path(key):
            return key
    inst = installed_browsers()
    return inst[0] if inst else None


def find_user_browser(cfg=None):
    key = pick_browser_key(cfg)
    if not key:
        return None, None
    return BROWSERS[key]["proc"], browser_path(key)


def browser_name(cfg=None):
    key = pick_browser_key(cfg)
    return BROWSERS[key]["name"] if key else "браузер"


def _is_running(proc):
    try:
        out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {proc}", "/NH"], capture_output=True, text=True,
                             creationflags=0x08000000, timeout=10).stdout
        return proc.lower() in out.lower()
    except Exception:
        return False


def browser_args():
    ext = str(C.ROOT / "extension")
    return [f'--load-extension={ext}'] + BROWSER_FLAGS


def patch_browser_shortcuts(exe_path):
    """Дописывает в ярлыки браузера (рабочий стол, панель задач, меню «Пуск») запуск расширения Donini
    и настройку «работать позади других окон». Только если этого там ещё нет."""
    if not sys.platform.startswith("win") or not exe_path:
        return
    args = " ".join(a if " " not in a else f'"{a}"' for a in browser_args()).replace('"', '`"')
    exe = exe_path.replace("'", "''")
    ps = (
        "$ws=New-Object -ComObject WScript.Shell;"
        "$dirs=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),"
        "(Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'),"
        "(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),"
        "(Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'));"
        "foreach($d in $dirs){ if(Test-Path $d){ Get-ChildItem -Path $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {"
        " try { $l=$ws.CreateShortcut($_.FullName);"
        f" if($l.TargetPath -ieq '{exe}' -and $l.Arguments -notmatch 'load-extension'){{"
        f" $l.Arguments=($l.Arguments + ' {args}').Trim(); $l.Save() }} }} catch {{}} }} }} }}"
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                       creationflags=0x08000000, timeout=60)
    except Exception:
        pass


def _ps(script, timeout=30):
    return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                          capture_output=True, text=True, encoding="utf-8", errors="ignore",
                          creationflags=0x08000000, timeout=timeout).stdout or ""


def browser_status():
    """Запущен ли браузер пользователя и с настройкой «работать позади других окон» (без неё OLX/Njuškalo
    в фоновом окне стоят и ждут). Смотрим командную строку главного процесса браузера."""
    if not sys.platform.startswith("win"):
        return {"running": False, "ok": True, "name": ""}
    proc, path = find_user_browser()
    if not path:
        return {"running": False, "ok": True, "name": ""}
    name = browser_name()
    try:
        out = _ps("[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
                  f"Get-CimInstance Win32_Process -Filter \"Name='{proc}'\" | ForEach-Object {{ $_.CommandLine }}", 20)
    except Exception:
        return {"running": _is_running(proc), "ok": True, "name": name, "unknown": True}
    mains = [l for l in out.splitlines() if l.strip() and "--type=" not in l]
    if not mains:
        return {"running": False, "ok": True, "name": name}
    ok = any("CalculateNativeWinOcclusion" in l for l in mains)
    return {"running": True, "ok": ok, "name": name}


def restart_browser(url):
    """Закрывает браузер и открывает его снова — уже с расширением и настройкой фоновой работы.
    Открытые вкладки восстанавливаются."""
    proc, path = find_user_browser()
    if not path:
        return False
    try:
        subprocess.run(["taskkill", "/IM", proc], capture_output=True, creationflags=0x08000000, timeout=15)
        for _ in range(20):
            if not _is_running(proc):
                break
            time.sleep(0.5)
        if _is_running(proc):
            subprocess.run(["taskkill", "/F", "/T", "/IM", proc], capture_output=True, creationflags=0x08000000, timeout=15)
            time.sleep(1.5)
        subprocess.Popen([path] + browser_args() + ["--restore-last-session", url], creationflags=0x08000000)
        return True
    except Exception:
        return False


def patch_browser_autostart(exe_path):
    """Яндекс запускается вместе с Windows (и работает в фоне) — дописываем настройку и в его автозапуск,
    иначе он стартует без неё, и ярлыки уже не помогают (браузер-то уже запущен)."""
    if not sys.platform.startswith("win") or not exe_path:
        return
    args = " ".join(browser_args()).replace("'", "''")
    full = exe_path.replace("'", "''").replace("[", "`[").replace("]", "`]")
    ps = (
        "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';"
        "$p=Get-ItemProperty -Path $k -ErrorAction SilentlyContinue; if($p){"
        "$p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {"
        f" $v=[string]$_.Value; if($v -like '*{full}*'){{"
        f"  if($v -notmatch 'CalculateNativeWinOcclusion'){{ Set-ItemProperty -Path $k -Name $_.Name -Value ($v + ' {args}') }} }} }} }}"
    )
    try:
        _ps(ps, 30)
    except Exception:
        pass


# ---------- окно программы: отдельное приложение Windows (WebView2), без Chrome ----------
WINDOW_TITLE = "Donini Poster"
STORE_URL = "https://doninisklep.com"
STORE_ICON_URLS = [STORE_URL + "/wp-content/uploads/2026/05/6d5479a1-6728-4547-aca1-f85384259aee.jpg"]
STORE_LOGO_URLS = [STORE_URL + "/wp-content/uploads/2026/05/donini_logo_300x120.jpg"]


def _webview_available():
    import importlib
    import importlib.util
    try:
        importlib.invalidate_caches()
        return importlib.util.find_spec("webview") is not None
    except Exception:
        return False


def ensure_webview(log=print):
    """Один раз ставит компонент окна программы (pywebview: окно Windows на движке Edge WebView2)."""
    if not sys.platform.startswith("win") or _webview_available():
        return True
    py = C.ROOT / "python" / "python.exe"
    if not py.exists():
        return False
    log("🪟 Устанавливаю компонент окна программы (один раз, около минуты)…")
    try:
        pip = [str(py), "-m", "pip", "install", "--no-warn-script-location", "-q", "--prefer-binary"]
        kw = dict(capture_output=True, text=True, encoding="utf-8", errors="ignore", creationflags=0x08000000, timeout=600)
        subprocess.run(pip + ["setuptools", "wheel"], **kw)
        r = subprocess.run(pip + ["--no-build-isolation", "pywebview"], **kw)
        ok = r.returncode == 0 and _webview_available()
    except Exception as e:
        ok, r = False, None
        log(f"⚠️ pip: {e}")
    if ok:
        log("✅ Окно программы готово — в следующий раз программа откроется отдельным окном, без браузера")
    else:
        err = ((r.stderr or r.stdout) if r is not None else "") or ""
        err = " ".join(err.strip().splitlines()[-3:])[:400]
        log("⚠️ Не получилось установить окно программы — пока открываю в браузере. Причина: " + (err or "неизвестно"))
    return ok


def ensure_store_icon(log=print):
    """Значок программы = логотип магазина doninisklep.com (скачивается один раз)."""
    web = C.ROOT / "app" / "web"
    done = web / "store_icon.done"
    if done.exists():
        return
    import io
    import urllib.request
    from PIL import Image, ImageDraw

    def get(urls):
        for u in urls:
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 DoniniPoster"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    return r.read()
            except Exception:
                continue
        return None
    try:
        logo = get(STORE_LOGO_URLS)
        if logo:
            Image.open(io.BytesIO(logo)).convert("RGB").save(web / "store_logo.png")
        ico = get(STORE_ICON_URLS)
        if not ico:
            return
        src = Image.open(io.BytesIO(ico)).convert("RGBA")
        S = 256
        canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=48, fill=255)
        bg = Image.new("RGBA", (S, S), (255, 255, 255, 255))
        canvas.paste(bg, (0, 0), mask)
        src.thumbnail((S - 24, S - 24), Image.LANCZOS)
        canvas.alpha_composite(src, ((S - src.width) // 2, (S - src.height) // 2))
        canvas.save(web / "icon.png")
        canvas.save(web / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        done.write_text("ok", encoding="utf-8")
        log("🖼 Значок программы — логотип магазина DONINI")
    except Exception as e:
        log(f"Значок магазина не скачался ({e}) — оставляю обычный")


def _bring_window_to_front():
    try:
        import ctypes
        u = ctypes.windll.user32
        h = u.FindWindowW(None, WINDOW_TITLE)
        if h:
            u.ShowWindow(h, 9)  # SW_RESTORE
            u.SetForegroundWindow(h)
            return True
    except Exception:
        pass
    return False


def open_app_window(url, cfg):
    """Открывает окно программы: отдельное приложение (если компонент окна установлен), иначе — окно браузера."""
    if sys.platform.startswith("win") and _webview_available() and cfg.get("native_window", True) is not False:
        if _bring_window_to_front():
            return
        try:
            subprocess.Popen([_pythonw(), str(C.ROOT / "run.pyw"), "--window", url], cwd=str(C.ROOT))
            return
        except Exception:
            pass
    open_ui_in_browser(url, cfg)


def run_window(url):
    """Процесс окна программы. Закрыли окно — программа продолжает работать в фоне."""
    cfg = C.load_config()
    try:
        import ctypes
        ctypes.windll.kernel32.CreateMutexW(None, False, "DoniniPosterWindow")
        if ctypes.windll.kernel32.GetLastError() == 183:  # окно уже открыто — показываем его
            _bring_window_to_front()
            return
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Donini.Poster")
    except Exception:
        pass
    ico = C.ROOT / "app" / "web" / "icon.ico"
    try:
        import webview
        w = webview.create_window(WINDOW_TITLE, url, width=1380, height=900, min_size=(900, 600),
                                  background_color="#121014", text_select=True)

        def on_shown():
            try:
                import clr  # pythonnet — ставится вместе с pywebview
                clr.AddReference("System.Drawing")
                from System import Action
                from System.Drawing import Icon
                form = w.native
                form.Invoke(Action(lambda: setattr(form, "Icon", Icon(str(ico)))))
            except Exception:
                pass
        w.events.shown += on_shown
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(C.DATA / "window"))
    except Exception:
        open_ui_in_browser(url, cfg)


def open_ui_in_browser(url, cfg):
    """Открывает программу отдельным окном-приложением (без вкладок и адресной строки) в браузере пользователя.
    Если браузер ещё не запущен — запускает его сразу с включённым расширением Donini."""
    if not sys.platform.startswith("win") or cfg.get("launch_browser_with_extension", True) is False:
        webbrowser.open(url)
        return
    proc, path = find_user_browser()
    if not path:
        webbrowser.open(url)
        return
    app = [f"--app={url}", "--window-size=1360,880"]
    try:
        if _is_running(proc):
            subprocess.Popen([path] + app, creationflags=0x08000000)
        else:
            subprocess.Popen([path] + browser_args() + app, creationflags=0x08000000)
    except Exception:
        webbrowser.open(url)


def start_browser_hidden():
    """Автозапуск с Windows: браузер стартует в фоне (без окна) сразу с расширением Donini —
    авто-режим и выставление работают, даже если окно программы не открывали."""
    if not sys.platform.startswith("win"):
        return
    proc, path = find_user_browser()
    if not path or _is_running(proc):
        return
    try:
        subprocess.Popen([path] + browser_args() + ["--no-startup-window"], creationflags=0x08000000)
    except Exception:
        pass


async def amain(open_ui=True, autostart=False):
    from .engine import Engine
    from .server import create_app

    engine = Engine()
    engine.quit_event = asyncio.Event()
    engine.version = APP_VERSION
    port = int(engine.cfg.get("port", 8765))
    app = create_app(engine)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False))
    server.install_signal_handlers = lambda: None

    tasks = [asyncio.create_task(server.serve()), asyncio.create_task(engine.run())]
    engine.log(f"Версия программы {APP_VERSION}, браузер: {engine.cfg.get('browser_channel') or 'встроенный'}")
    if open_ui:
        asyncio.get_event_loop().call_later(1.5, lambda: open_app_window(f"http://127.0.0.1:{port}", engine.cfg))
    elif autostart and engine.cfg.get("launch_browser_with_extension", True) is not False:
        engine.log("🚀 Запуск вместе с Windows — работаю в фоне, окно программы: ярлык «Donini Poster»")
        asyncio.get_event_loop().run_in_executor(None, start_browser_hidden)
    def _setup_app():
        ensure_store_icon(engine.log)
        ensure_desktop_shortcut()
        if engine.cfg.get("autostart", True) and engine.cfg.get("_autostart_set"):
            set_autostart(True)  # обновить значок и у ярлыка автозапуска
        ensure_webview(engine.log)
    asyncio.get_event_loop().run_in_executor(None, _setup_app)
    engine.pick_browser = lambda: pick_browser_key(engine.cfg)
    engine.browser_info = lambda: {"installed": installed_browsers(), "names": {k: v["name"] for k, v in BROWSERS.items()},
                                   "default": default_browser_key(), "current": pick_browser_key(engine.cfg),
                                   "auto": pick_browser_key({**engine.cfg, "user_browser": "auto"})}
    def _restart_self():
        """Перезапуск программы (после восстановления из резервной копии)."""
        try:
            run = str(C.ROOT / "run.pyw")
            subprocess.Popen(f'cmd /c "timeout /t 3 /nobreak >nul & start "" "{_pythonw()}" "{run}""',
                             shell=True, creationflags=0x08000000)
        except Exception:
            pass
        engine.quit_event.set()
    engine.restart_self = _restart_self

    def _update_loop():
        """Раз в 6 часов: есть ли новая версия на GitHub. Есть — окно программы покажет «Обновить»."""
        from . import updater
        seen = None
        time.sleep(20)
        while True:
            try:
                info = updater.check(engine.cfg)
                engine.update_info = info
                if info.get("available") and info.get("latest") != seen:
                    seen = info["latest"]
                    engine.log(f"⬆ Доступна новая версия программы {info['latest']} — в окне программы «Обновить»")
            except Exception:
                pass
            time.sleep(6 * 3600)
    # отдельный «фоновый» поток: не держит программу при выключении (иначе она не закрывается и не обновляется)
    import threading
    threading.Thread(target=_update_loop, daemon=True, name="updates").start()
    engine.set_autostart = set_autostart
    engine.autostart_state = autostart_state
    if engine.cfg.get("autostart", True) and not engine.cfg.get("_autostart_set"):
        # один раз включаем автозапуск по умолчанию (выключить: Настройки → «Запускать вместе с Windows»)
        def _first_autostart():
            if set_autostart(True):
                cfg = C.load_config()
                cfg["autostart"] = True
                cfg["_autostart_set"] = True
                C.save_config(cfg)
                engine.cfg = C.load_config()
                engine.log("🚀 Включён автозапуск вместе с Windows (выключить: Настройки → «Программа»)")
        asyncio.get_event_loop().run_in_executor(None, _first_autostart)
    if engine.cfg.get("launch_browser_with_extension", True) is not False:
        asyncio.get_event_loop().run_in_executor(None, lambda: patch_browser_shortcuts(find_user_browser()[1]))
        asyncio.get_event_loop().run_in_executor(None, lambda: patch_browser_autostart(find_user_browser()[1]))
        engine.browser_status = browser_status
        engine.restart_browser = lambda: restart_browser(f"http://127.0.0.1:{port}")

        def _check_flags():
            time.sleep(8)
            st = browser_status()
            if st.get("running") and not st.get("ok"):
                if engine.cfg.get("auto_restart_browser", True) is not False:
                    # браузер запустился вместе с Windows без настройки — перезапускаем сами (вкладки вернутся)
                    engine.log(f"🔄 {st['name']} запущен без настройки фоновой работы — перезапускаю его с ней "
                               "(открытые вкладки вернутся)…")
                    if restart_browser(f"http://127.0.0.1:{port}"):
                        time.sleep(10)
                        st2 = browser_status()
                        engine.log("✅ Браузер перезапущен с фоновым режимом" if st2.get("ok") else
                                   "⚠️ Не получилось включить фоновый режим браузера — нажмите в окне программы «🔄 Перезапустить браузер правильно»")
                        return
                engine.log(f"⚠️ {st['name']} запущен без настройки фоновой работы — OLX и Njuškalo в фоне будут ждать. "
                           "В окне программы нажмите «🔄 Перезапустить браузер правильно».")
        asyncio.get_event_loop().run_in_executor(None, _check_flags)
    await engine.quit_event.wait()
    server.should_exit = True
    await engine.shutdown()
    for t in tasks:
        t.cancel()


def _apply_restore():
    """Есть файлы из резервной копии (data/_restore) — кладём их на место, пока программа ещё не работает."""
    import shutil
    src = C.DATA / "_restore"
    if not src.is_dir():
        return
    for f in src.rglob("*"):
        if f.is_file():
            t = C.DATA / f.relative_to(src)
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, t)
    shutil.rmtree(src, ignore_errors=True)


def main():
    if "--window" in sys.argv:
        i = sys.argv.index("--window")
        if sys.stdout is None or sys.stderr is None:
            C.DATA.mkdir(exist_ok=True)
            sys.stdout = sys.stderr = open(C.DATA / "window_log.txt", "a", encoding="utf-8", buffering=1)
        cfg = C.load_config()
        run_window(sys.argv[i + 1] if len(sys.argv) > i + 1 else f"http://127.0.0.1:{int(cfg.get('port', 8765))}")
        return
    try:
        from . import updater
        if updater.apply_pending():  # скачанное обновление ставим до запуска (файлы ещё не заняты)
            os.execv(sys.executable, [sys.executable] + sys.argv)  # перезапуск уже новой версией
    except Exception:
        pass
    _apply_restore()
    cfg = C.load_config()
    if not cfg.get("_ext_detect_v2"):
        # раньше окно программы (Edge WebView2) ошибочно считалось браузером с расширением — сбрасываем
        cfg.pop("_ext_browser", None)
        cfg["_ext_detect_v2"] = True
        C.save_config(cfg)
    port = int(cfg.get("port", 8765))
    autostart = "--autostart" in sys.argv
    open_ui = "--no-ui" not in sys.argv and not autostart
    if port_busy(port):
        if running_version(port) == APP_VERSION:
            # эта же версия уже работает в фоне — просто открываем её окно
            if open_ui:
                open_app_window(f"http://127.0.0.1:{port}", cfg)
            return
        # работает старая версия (после обновления) — перезапускаем на новую
        stop_running(port)
    # при запуске через pythonw (без консоли) пишем вывод в файл
    if sys.stdout is None or not sys.stdout.isatty():
        C.DATA.mkdir(exist_ok=True)
        log = open(C.DATA / "log.txt", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
    try:
        asyncio.run(amain(open_ui, autostart))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
