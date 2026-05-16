# Security Posture

A short, honest summary of what `pursue-vision-mcp` does to your machine, your ChatGPT session, and your data.

## What this software is

It's a local HTTP daemon that connects to your already-running Chrome via the Chrome DevTools Protocol (CDP) and performs scripted UI actions on an authenticated **chatgpt.com** tab — clicking the upload button, typing in the composer, waiting for a reply, reading the reply text.

There is no Anthropic, OpenAI, Google, or any other API key involved. It works because you are already signed in to ChatGPT in your browser.

## What it never does

- Sends your credentials, cookies, or session tokens off your machine
- Makes any outbound network call other than:
  - The CDP loopback to `http://127.0.0.1:9222` (your Chrome)
  - DNS lookups your OS would have made anyway
  - Whatever **your Chrome** chooses to send to `chatgpt.com` while you're using it
- Stores, logs, or transmits the content of your transcriptions anywhere
- Holds an HTTP listener on anything other than `127.0.0.1`
- Runs at elevated privilege (no `sudo` / Admin needed)
- Modifies any Chrome setting, extension, or profile

## What it does do

- Binds an HTTP server to `127.0.0.1:9223` (configurable via `PURSUE_VISION_PORT`)
- On first run, generates a 192-bit bearer token and writes it to `~/.pursue-vision-token` (file mode `0600`)
- Requires `Authorization: Bearer <token>` on every authenticated route
- Validates that any `filePaths` in incoming requests resolve under your home directory or the directory the daemon was started in. Paths outside that jail are rejected with `403`
- Reads those files from disk and uses Playwright's CDP connection to upload them to your ChatGPT tab as if you had clicked the paperclip yourself
- Reads the assistant reply text back out of the DOM and returns it to the caller

## Threats it doesn't defend against

- **A malicious local process** that knows your bearer token can use the daemon for the same things you can. Don't share `~/.pursue-vision-token`. Token rotation: just delete the file and restart the daemon.
- **A rogue Chrome extension** could already see everything you do in your ChatGPT tab. This daemon doesn't make that worse.
- **Compromise of your ChatGPT account** is a problem this daemon can't help you with — but it also can't cause it. The login flow is your browser, not us.
- **Sandbox escape from Chrome** is a Chrome problem, not a daemon problem.

## ChatGPT terms of service

You should read OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/). In particular, you are responsible for whether automated UI driving of a logged-in session is consistent with their terms for your account tier. This daemon is **a tool** — how you use it is up to you. The maintainers of this open-source release make no claim about its compliance with any specific third-party terms.

## Reporting a vulnerability

Open an issue on the parent repo with the prefix `[security]` or email the repo owner via their GitHub profile. Patches welcome.
