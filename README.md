# Vantell

**Share what you know — never your notes.**

Vantell lets colleagues discover what topics you have knowledge about, without your notes ever leaving your vault. You choose folders you're willing to share from; Vantell publishes only **topic labels and note counts** from them. Everything else — and all note *contents*, always — stays on your machine.

## Install

In Obsidian, open *Settings → Community plugins → Browse*, search for “Vantell”, then Install and Enable.

## The Vantell panel

Click the **radio icon** in the left ribbon (or run the “Open the panel” command) for a live side panel: the **connected brains** in your org shown as a small constellation and topic-tagged cards (click any to knock them), the **requests** waiting for your answer, the **answers** that came back to your knocks, and the **knocks you've sent** with their status. It's the interactive home for the mesh — everything else (setup, per-note sharing) still lives in commands and settings.

## How it works

1. **Link your account** — enter a one-time code from [app.vantell.ai](https://app.vantell.ai) (free account, 2 minutes to create).
2. **Choose your folders** — everything starts private. Pick the folders you'd share from, and whether each is visible to your team or your whole org.
3. **Review** — see the exact list of topic labels and counts before anything is sent. What you see is literally all there is; the payload format has no field that could carry note contents.
4. **Go live** — colleagues can now find you by what you know and send you a request. You approve or deny every request from your dashboard; each decision is recorded in a receipt you can review.

## What leaves your vault — the complete list

This plugin makes exactly two kinds of network calls, both to `api.vantell.ai`, both shown to you before they happen:

| When | What is sent |
|---|---|
| Linking (once per device) | Your one-time code + this device's public key |
| Going live / updating | Topic labels, note counts, the names of folders **you chose**, and a signed timestamp |
| While Obsidian is open (every 2 min) | A signed **check for incoming requests** — an empty-bodied read of your own inbox and consent state. Nothing about your vault is sent |
| When you answer a request | **Only the text you typed** in the answer box, plus the titles you explicitly ticked as sources — after you approved the request on your dashboard |
| If you turn on AI drafting *(off by default)* | The text of shareable notes matching the request's topic, sent to **your own Anthropic account** with **your** API key — never to Vantell, never to the person who asked. See below |

Never sent: note contents (except AI drafting, below), note titles (unless you explicitly share a note or tick one as an answer source), names of unchosen folders (they're reported only as one anonymous total), file paths, or any telemetry. Incoming requests are displayed as inert text and never written into your vault or executed.

### Answer drafting — two ways, both optional

When you answer a request you can draft it yourself, or get a hand:

**Draft with your own Claude (no setup, any plan).** The answer screen has a **“Draft with my Claude”** button. By default it builds a *lean* prompt: the question, the context, and the **paths of the shareable notes** most relevant to the topic — and lets your own Claude open and read them. This is ideal when your Claude can see the vault (Claude Code running in the folder, or the folder attached), and keeps the prompt tiny. If your Claude *can't* open the vault (e.g. plain claude.ai), click **“Include note text”** and it switches to a self-contained prompt with condensed excerpts. Either way you copy it, paste into your Claude, paste the answer back, and Send. The plugin sends nothing anywhere; the note text moves only when *you* paste it. Works on Free, Pro, Max, or Team — no API key.

**Automatic drafting (advanced, needs an Anthropic API key).** If you have a developer key from console.anthropic.com, add it in settings and a second button drafts in place. That path sends the same shareable, topic-matching notes to **your own Anthropic account** (never to Vantell, never to the person who asked); the key is stored on this device only and never synced. Most people don't need this — the paste path above covers every Claude plan.

Either way, the draft lands in the editable box, you review and edit it, and nothing reaches the person who asked until you click Send. Folders that look like they contain other people's words (emails, transcripts, chat exports) or notes about people are excluded automatically — even inside folders you chose — and this cannot be overridden.

## Does Vantell change my notes?

No — with one deliberate, visible exception. Your folder choices are saved to a small settings file (`.vantell.yml`) in your vault, not to any note. The only time a note is touched is when **you** run "Share this note" or "Stop sharing this note" on that specific note: one `visibility` property is added, visible in Obsidian's Properties panel, removable at any time. The note's content is never altered (the plugin verifies the body survives byte-for-byte before writing).

## Leaving is a first-class feature

"Remove Vantell from this vault" (in settings, or as a command) puts the vault back the way Vantell found it: it takes your published listing off the mesh (on by default — topic labels, counts and folder names disappear for colleagues), strips Vantell's sharing properties from every note (bodies verified byte-for-byte; pre-existing metadata like `topics` is never touched), deletes the `.vantell.yml` settings file, and deletes this device's signing key — after showing you the exact list of affected notes. The same "Remove published data" action also exists on your dashboard (Settings → Data & deletion), usable even after the device key is gone. Then uninstall the plugin like any other.

## Security

- Your device signs its requests with a key generated locally (Ed25519). The key is stored **device-locally** and is never synced with your vault — not through Obsidian Sync, iCloud, or git — and never written into any note or plugin data file.
- No password is ever entered in the plugin. Linking uses a single-use code that expires in 60 minutes.
- The plugin's full source — including the vault scanner (`vaultscan-core`) — is public: [github.com/goffiti/vantell-obsidian](https://github.com/goffiti/vantell-obsidian). Audit it, or ask your own AI to.

## Requirements & disclosures

- Requires a **free Vantell account** (your work email determines your org). The plugin depends on the Vantell service to relay what you publish; it does nothing without an account.
- **Network use**: only the calls listed above, only to your Vantell server. The scan itself makes zero network calls.
- **No telemetry.** The plugin collects no analytics of any kind.

## For teams

Vantell implements the [Knock Protocol](https://vantell.ai): colleagues' requests to go deeper than topic labels arrive as *knocks* you explicitly approve or deny, with consent receipts and a content-free audit trail. Your org admin sees metadata only — never contents, never question texts.
