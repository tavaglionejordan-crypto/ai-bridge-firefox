# AI Bridge for Firefox — v0.11.0

A local Windows/Firefox relay connecting a ChatGPT conversation to Codex CLI, Grok and Gemini through your own signed-in sessions. This repository contains the runtime files needed to install and use the current snapshot. It has no production npm dependencies.

## Requirements

- Windows and Firefox 128 or newer.
- Node.js available on PATH (local checks used Node.js 24).
- Codex CLI installed, available on PATH, and signed in with your own account.
- Your own signed-in ChatGPT session. Grok and Gemini are optional paired destinations.

## Setup

1. On GitHub choose **Code → Download ZIP**, extract it to a permanent folder, and keep the folder structure intact. Do not run the installer from inside the ZIP.
2. Install/sign in to Codex CLI using its normal setup. The launcher suggests `npm install -g @openai/codex` if Codex is missing.
3. Read the access-mode section below and choose the appropriate mode before running jobs.
4. Run **Install One Click.cmd**. It creates the local native-host registration for your Windows account. It generates machine-specific files in `native/`; none are supplied in this repository.
5. In Firefox open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension/manifest.json` from this folder.
6. Open the intended ChatGPT conversation and click the AI Bridge toolbar icon. The popup can start/reuse the local helper and start Watch. If necessary use **Connect & watch**.
7. Open the extension's **? Help**, copy its coordinator instructions into ChatGPT, and then give ChatGPT a task.
8. To use Grok or Gemini, open the intended signed-in conversation and pair it using the extension. Keep the relevant tabs open.

Temporary Firefox add-ons must be loaded again after Firefox restarts. This source snapshot is not an AMO-signed packaged extension. If you move the extracted folder, run the installer again from the intended permanent location; an existing registration belonging to another installation is deliberately preserved rather than silently replaced.

## Access mode and working folder

The supplied `bridge/config.json` preserves the project's current default: `fullAccess: true`. Codex jobs run without CLI approval prompts and can modify files outside the working folder under your Windows account. To use the restricted workspace mode, set `fullAccess` to `false` before starting the bridge. Use a dedicated project folder and give precise task paths.

The default working folder is a sibling folder named `test` beside this extracted project folder. A manual bridge can use another folder:

```powershell
node .\bridge\server.cjs "C:\Projects\MyProject" --restricted
```

**Start Bridge.cmd** is the manual fallback. Its terminal prints a local token for Advanced setup; keep that token private. Your installation creates its own token and state. No original user's credentials, job history, browser sessions or outputs are included here.

## Included functionality

- Separate Codex, Grok and Gemini queues, one active job per agent.
- Sequential and dependency plans, parallel ready branches, review checkpoints and queue editing.
- Guarded text/image/file submission, result receipts, duplicate prevention and Gemini cooldown.
- A local outputs library with previews, downloads and reuse, with a 500 MB content budget.
- Connection checks, saved read checkpoints, deliberate Reconnect controls and recovery observation.
- Optional desktop notifications and detailed diagnostics.
- A persisted goal ledger and bounded coordinator wake-ups. Inspect wake-ups in **Advanced → Diagnostics → Coordinator wake-ups**.

## Current limits

The complete unattended-goal milestone is unfinished: general goal execution budgets and evidence-backed acceptance-criterion review are not fully implemented. A successful agent reply is not automatic proof that the overall goal is complete. Browser and computer sleep, authentication, site-layout changes and uncertain submissions can still require attention. Firefox must remain running for timed wake-ups.

The snapshot has automated coverage using isolated headless browser pages with mocked providers and extension APIs, plus real local storage/HTTP/file tests. Authenticated live Firefox/provider behavior has not been verified as part of these checks. Finish accepted work before reloading the add-on and refreshing paired tabs.

For everyday operation use the bundled **? Help** instructions, **Jobs**, and **Advanced → Diagnostics**. Tests, generated logs, downloaded tools, old upgrade notes, private runtime state and machine-specific native-host registrations were deliberately omitted from this distribution.
