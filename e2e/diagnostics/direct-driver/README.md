# Direct `tauri-driver` attempt — retained as evidence, not as a harness

This was the first real-binary harness. It is kept because what it measured is worth keeping, and
deleting it would invite someone to try the same approach again.

## What it established

- Process isolation works. `OSG_E2E_DATA_ROOT` gives a run its own data, cache and logs, and the
  developer's live database is untouched — verified by comparing the live log's mtime to the second
  across an isolated run.
- The application starts correctly every time. Its own diagnostics show `app.ready` followed by two
  `app.page_load_finished` events on every launch, including every launch that the harness then
  reported as "the editor never rendered".

## Why it was replaced rather than tuned

A new WebDriver session binds non-deterministically to one of the application's WebView2 targets.
Some sessions land on `https://tauri.localhost/` and render; some land on `about:blank` and report an
empty `#root` indefinitely. That reads exactly like an intermittent product failure and is not one.

Two repairs were tried and both failed for the same underlying reason — the binding is decided when
the session is created:

1. Switching windows. `getWindowHandles()` returns only the blank target, so the editor is not
   reachable from a session bound to it.
2. Recreating the session, up to six times. Every attempt landed on `about:blank`.

That converts an architectural ambiguity into a lottery, which is why the direction changed to the
maintained embedded provider: a WebDriver server inside the E2E binary has no target to choose.

## One false lead worth remembering

The `about:blank` document throws `Uncaught DOMException: Failed to read the 'localStorage' property
from 'Window': Access is denied for this document.` It is a property of that document, not of the
editor, and it is convincing enough to send the next person down the wrong path for an hour.
