import sys
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

import fixtures as fx  # noqa: E402
from harness import Env, init_script, make_router  # noqa: E402


@pytest.fixture(scope="session")
def browser():
    # Own headless chromium, never a shared debugging port.
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        yield b
        b.close()


@pytest.fixture
def open_env(browser):
    """open_env(html_or_routes, url=..., script=[...], store={...}, api=...) -> Env with ats.js loaded and the page open."""
    made = []

    def _open(serve, url=None, *, script=None, store=None, api=None):
        ctx = browser.new_context()
        ctx.add_init_script(script=init_script(store, script))
        ctx.route("**/*", make_router(serve, api))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        env = Env(ctx, page, errors)
        made.append(env)
        env.goto(url or fx.attempt_url())
        return env

    yield _open
    for env in made:
        env.ctx.close()
    for env in made:
        assert not [e for e in env.errors if "net::ERR" not in e and "Failed to load resource" not in e], env.errors


def state(env, *, selector="ol.attempt-question-list > li"):
    """What the page shows per question: checked option indices, text values."""
    return env.page.evaluate(
        """sel => [...document.querySelectorAll(sel)].map(li => ({
            checked: [...li.querySelectorAll('input[type=radio],input[type=checkbox]')].flatMap((i, n) => i.checked ? [n] : []),
            values: [...li.querySelectorAll('input[type=text]')].map(i => i.value),
            editor: li.querySelector('.ql-editor[contenteditable=true]')?.textContent ?? null,
        }))""",
        selector,
    )


def solve_to_hud(env, pattern, *, call="do-solve", timeout=20000):
    reply = env.call(call)
    env.wait_hud(pattern, timeout=timeout)
    return reply
