# ATS Solver

> A Chrome extension that finds your tests on Blackboard Ultra, asks an AI model each question, and clicks the answers.

![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Tests](https://img.shields.io/badge/offline%20tests-86-brightgreen)
![Site](https://img.shields.io/badge/site-ats.blackboard.com-lightgrey)

It runs on `ats.blackboard.com`. It reads the site's current markup and its REST API, so when Blackboard changes either, it stops working until someone updates the selectors in `ats.js`.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [What it answers](#what-it-answers)
- [What it leaves alone](#what-it-leaves-alone)
- [The popup](#the-popup)
- [How it picks answers](#how-it-picks-answers)
- [Install](#install)
- [Settings](#settings)
- [When something goes wrong](#when-something-goes-wrong)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Credits](#credits)

## Features

- **One click for a whole course, or every course.** Assessments are taken nearest due date first.
- **Five model services**, two of them with no key to buy: OpenRouter, Google Gemini, OpenAI, DeepSeek (site login) and Gemini (site login).
- **Retakes** an assessment while attempts remain and the grade is below full marks.
- **Double-checks doubtful answers** by asking again with the choices in a different order.
- **Stops cleanly.** `Ctrl+Shift+X` or the Stop button halts a run, and nothing submits after you press it.
- **Recovers from model hiccups** by asking again with growing waits instead of dropping the attempt.
- **Tested offline** against synthetic Blackboard pages, never the live site.

## Quick start

Five minutes and Chrome. The [full walkthrough](QUICKSTART.md) has the details.

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension's **Options**, choose a service, paste its key, **Test key**, **Save**.
3. Sign in at `ats.blackboard.com` with **Sign in with third-party account** → **ATS-SSO**.
4. Open the popup on any Blackboard page and press **Solve all courses**.

## What it answers

| Question type | Notes |
| --- | --- |
| Multiple choice, true/false | With or without a reading passage |
| Select all that apply | |
| Short text, fill in the blank | |
| Reading comprehension | A text block above the questions is sent with every question after it |
| Figures | A question that points at a picture the page text lacks goes to the model with a screenshot |

Arabic and English tests both work; the text goes to the model as it appears on the page.

> Only multiple choice has been run against a live test. The other types follow Blackboard's markup conventions and are untested. If one misbehaves, the attempt is left open for you.

## What it leaves alone

It leaves essays, matching, ordering and anything it does not recognise, and it will not submit an attempt that still has one. The popup lists each skipped title with the reason.

| Skipped | Why |
| --- | --- |
| Assignments | File uploads and written work |
| No attempts left | `0 attempts left` on the overview |
| Full marks already | The overview shows full marks |
| Respondus LockDown Browser, proctored | The extension cannot run there |
| Past due | The due date has passed and the course enforces it |

### Retakes

An assessment that already has an attempt handed in (the overview offers "Start attempt 2") is **retaken** while attempts remain and the grade is below full marks. The full-marks check looks for text such as `Grade: 100/100`, `Score 10 / 10` or `Grade 100%` on the overview. That wording has not been checked against the live site, so an unrecognised format means a retake. If your course keeps the last attempt rather than the best one, a retake can lower the grade.

## The popup

The popup checks where the tab is and shows the buttons that apply.

| You are on | Buttons |
| --- | --- |
| An open attempt | **Solve the open attempt** |
| An assessment's overview | **Start and solve this assessment**, **Solve this course**, **Solve all courses** |
| A course | **Solve this course**, **Solve all courses** |
| Anywhere else in Blackboard | **Solve all courses** |

**Solve all courses** reads your course list and every course's gradebook through the site's own API, then opens each assessment's overview, starts or continues the attempt, answers it and submits. If a question cannot be answered, it leaves the attempt open and does not submit.

**Solve the open attempt** answers an attempt you started yourself. It submits only when **Submit automatically** is on in the popup. Auto runs always submit what they finish.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+S` | Solve the open attempt |
| `Ctrl+Shift+X` | Stop a run |

The script checks for a stop before Start, between answer batches and before Submit. A run switches itself off after two hours.

## How it picks answers

- The model quotes the words that decide the answer and tests every choice before it answers. The reply is JSON with `evidence`, `answer`, `index`, `confidence` and `why`.
- An answer below 0.9 confidence, or any question with a passage, goes out again with the choices reversed. When the two answers disagree, a third order breaks the tie. Set `verify` to `false` to skip the extra calls.
- Questions that need no screenshot go to the model two at a time while the script clicks through the page in order.
- DeepSeek and the Gemini site login start a fresh chat for every question. Turn on **Keep using one chat** in Options to send all questions to one chat; a new chat then starts after 30 questions.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and select this folder.
3. Open the extension's Options, choose a service, paste its key, click Test key, then Save.
4. Sign in to `ats.blackboard.com`: press **Sign in with third-party account**, then **ATS-SSO**, and use your school account.

### Services

The extension uses the one you pick in Options. Each service keeps its own key, model and fallback model. Your browser stores the key and sends it to that service and nowhere else.

| Service | Needs | Default model |
| --- | --- | --- |
| **OpenRouter** (default) | A key from [openrouter.ai/keys](https://openrouter.ai/keys); one key reaches many models | `deepseek/deepseek-v4.1-flash` |
| **Google Gemini** | Your own key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.5-flash` |
| **OpenAI** | A key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `gpt-5-mini` |
| **DeepSeek** | Your chat.deepseek.com login, no key. Sign in on the site, then press "Copy token from the site" in Options | n/a |
| **Google Gemini (site login)** | Your gemini.google.com login, no key. Keep a signed-in tab open, because the extension sends its questions from that tab | n/a |

The DeepSeek site's chat cannot read images, so figure questions go to the model as text. The Gemini site login reads images.

## Settings

Options holds the provider, key, model, fallback model and the chat setting. The popup has a **Submit automatically** switch for the open-attempt path and a **Screenshot** setting: Auto sends a picture when a question needs one, and Never sends none.

Three settings have no screen. Set them from the service worker console on `chrome://extensions`, for example:

```js
chrome.storage.local.set({ concurrency: 2 })
```

| Key | Default | Effect |
| --- | --- | --- |
| `concurrency` | `2` | Model calls in flight at once for questions without a screenshot |
| `verify` | `true` | Second and third opinions on doubtful and passage questions |
| `rateWait` | `10000` | Milliseconds before the first retry when the model fails for the moment; later retries wait two and three times as long |

## When something goes wrong

| Symptom | What happens |
| --- | --- |
| The model returns nothing, hits a limit, or answers "something went wrong" | It is asked again up to three times with growing waits. The status line shows the model's own reason. If it never recovers, the run stops with the attempt left open. |
| The background worker is not listening yet | The message is retried for a few seconds. |
| "The extension was reloaded" | Refresh the Blackboard tab; the page still holds the old copy of the script. |
| The Submit button is missing or never turns on | The status line says so and leaves the attempt for you. |
| A paged attempt stops on a question | The status line lists the controls it could see, including whether Next is present but disabled. |

After the last question, **Submit** and **Submit Late** (after the due date) are both pressed and the confirmation dialog is accepted. Blackboard then loads its "Your submission was successful!" page; the run counts that as handed in and moves to the next assessment.

After you change the files, press reload on the extension's card, then press F5 on the Blackboard tab. The page script attaches when a tab loads, so an older tab keeps the old copy.

## Tests

`tests/` holds an offline suite that loads `ats.js` into a headless Chromium with a mocked `chrome.*` API and synthetic Blackboard pages. It never contacts the real site. Only the multiple-choice markup was copied from the live site; the other question types, the paged mode, the Start dialog and the confirmation page are modelled, so a pass there is not proof the live site behaves the same.

```sh
pip install pytest playwright
playwright install chromium
cd tests && python3 -m pytest -q
```

`test_e2e.py` runs a whole course: skipped assessments, a late retake that ends on the confirmation page, a model hiccup and a quiz with every supported question type. `tests/FINDINGS.md` lists the bugs the suite found and how each was fixed. Set `ATS_JS=/path/to/ats.js` to run the suite against another build. The full suite takes about five minutes.

## Project layout

| Path | Role |
| --- | --- |
| `ats.js` | Content script: reads the page, answers questions, drives Start, Next and Submit, runs the course loop |
| `background.js` | Service worker: owns the API key and every network call |
| `gemini-web.js` | Sends questions from a signed-in gemini.google.com tab |
| `popup.html`, `popup.js` | The popup that adapts to the page |
| `options.html`, `options.js` | Provider, key, model and chat settings |
| `content.css` | Styles for the status line shown on the page |
| `debug.js` | Records what happened so a bug can be described |
| `rules.json` | Sets the origin and referer headers on DeepSeek chat and Gemini image-upload requests |
| `tests/` | Offline Playwright suite |
| `QUICKSTART.md` | The five-minute walkthrough |

## Credits

[Alef Solver](https://github.com/Owlsnet/alef-solver) by Owlsnet supplied the extension layout, the provider setup and the README style. [arccxp](https://github.com/arccxp) wrote the LMS version this is forked from: the run loop, the voting and the popup that adapts to the page. The Blackboard Ultra version replaces its page script.
