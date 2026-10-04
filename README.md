# pi-ssh-image-clipboard

Ctrl+V image paste into **remote** [pi](https://github.com/badlogic/pi-mono)
sessions. Locally, pi's Ctrl+V grabs an image from your clipboard, writes a
temp file and inserts its path. On a headless box over ssh/mosh/et it silently
does nothing — this package makes it work, by fetching the clipboard image
from the machine you are *typing on* through a reverse tunnel riding your
ssh or [Eternal Terminal](https://eternalterminal.dev/) connection.

Works with any terminal (ghostty, iTerm2, ...) since the terminal is not
involved. Multi-client aware: if several boxes are attached to the same tmux
session, the image comes from the box that pressed Ctrl+V (resolved via tmux
`client_activity`).

## How it works

```
Mac: launchd (inetd-style) -> pngpaste          [nothing runs when idle]
        |  unix socket / TCP 127.0.0.1:7779
        |  reverse tunnel (et env-var socket, or ssh RemoteForward)
        v
remote: per-connection socket (+ ~/.pi-clip/by-tty/<tty>.sock symlink
        maintained by a login hook)
        v
pi extension: Ctrl+V -> pick socket of the most-recently-active tmux
        client -> fetch bytes -> /tmp/pi-clipboard-<uuid>.png -> insert path
```

The extension registers Ctrl+V **only on headless Linux** (no
`DISPLAY`/`WAYLAND_DISPLAY`), so it never shadows pi's built-in image paste
on desktop machines. With no live tunnel (e.g. connected via mosh, which
cannot forward anything) it is a silent no-op, matching stock behavior.

## Install (remote box running pi)

```bash
pi install git:github.com/pasky/pi-ssh-image-clipboard
```

Add the login hook to `~/.bashrc` (maps each login tty to that connection's
clipboard socket):

```sh
# pi-ssh-image-clipboard: map this login's tty to the client box's clipboard
# socket, so Ctrl+V in pi grabs the clipboard of the box you're typing from.
# ssh: LC_PI_CLIP names the box socket (~/.pi-clip/<box>.sock, RemoteForward).
# et:  PI_CLIP_SOCK is set by `et -r PI_CLIP_SOCK:/client/sock/path`.
if [ -z "$TMUX" ]; then
	_pi_clip_target=""
	if [ -n "$PI_CLIP_SOCK" ]; then
		_pi_clip_target="$PI_CLIP_SOCK"
	elif [ -n "$SSH_TTY" ] && [ -n "$LC_PI_CLIP" ]; then
		_pi_clip_target="$HOME/.pi-clip/$LC_PI_CLIP.sock"
	fi
	if [ -n "$_pi_clip_target" ] && _pi_clip_tty=$(tty 2>/dev/null); then
		case "$_pi_clip_tty" in /dev/pts/*)
			mkdir -p ~/.pi-clip/by-tty
			ln -sf "$_pi_clip_target" ~/.pi-clip/by-tty/"$(basename "$_pi_clip_tty")".sock
		esac
	fi
	unset _pi_clip_target _pi_clip_tty
fi
```

One-time: `mkdir -p ~/.pi-clip/by-tty && chmod 700 ~/.pi-clip`

Recommended if you use the ssh (RemoteForward) transport (needs root): let
sshd replace stale socket files after unclean disconnects, otherwise the
re-established forward fails until the stale `.sock` file is removed:

```bash
echo 'StreamLocalBindUnlink yes' | sudo tee /etc/ssh/sshd_config.d/60-pi-clip.conf
sudo sshd -t && sudo systemctl reload ssh
```

## Client box setup (Mac)

Any OS works if it serves its clipboard as an image on a local socket;
instructions below are for macOS.

Replace `pasky` below with your username, of course.

```bash
brew install pngpaste
```

Create `~/Library/LaunchAgents/org.pasky.clipserve.plist` — launchd itself
listens and spawns `pngpaste -` per connection (inetd-style, no daemon
running when idle). Adjust the two `/Users/pasky` paths; Intel Macs have
pngpaste at `/usr/local/bin/pngpaste`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>org.pasky.clipserve</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/pngpaste</string>
		<string>-</string>
	</array>
	<key>inetdCompatibility</key>
	<dict><key>Wait</key><false/></dict>
	<!-- keep pngpaste's stderr (e.g. "no image" error text) off the socket -->
	<key>StandardErrorPath</key><string>/tmp/pngpaste-clipserve.err</string>
	<key>Sockets</key>
	<dict>
		<!-- TCP listener: used by ssh RemoteForward -->
		<key>ListenerTCP</key>
		<dict>
			<key>SockNodeName</key><string>127.0.0.1</string>
			<key>SockServiceName</key><string>7779</string>
		</dict>
		<!-- Unix socket listener: used by et's env-var reverse tunnel -->
		<key>ListenerUnix</key>
		<dict>
			<key>SockPathName</key><string>/Users/pasky/.clipserve.sock</string>
		</dict>
	</dict>
</dict>
</plist>
```

Activate and test locally (screenshot to clipboard first, cmd-ctrl-shift-4):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.pasky.clipserve.plist
nc -U ~/.clipserve.sock | file -    # expect: PNG image data ...
nc 127.0.0.1 7779 | file -          # ditto
```

(After later plist edits: `launchctl bootout gui/$(id -u)/org.pasky.clipserve`,
`rm -f ~/.clipserve.sock`, then bootstrap again — launchd does not re-read
plists on its own.)

## Connecting

### Eternal Terminal — tested with et 6.2.11

```bash
alias et='et -k 1 -r PI_CLIP_SOCK:/Users/pasky/.clipserve.sock'
et thatbox
```

et creates a private per-connection socket on the remote
(`/tmp/et_forward_sock_XXXXXX/sock`, mode 0700), exports its path as
`$PI_CLIP_SOCK` in the session, and connects it to the client-side UNIX
socket named after the colon (absolute client-side path, no `~`). The
`~/.bashrc` hook does the rest; no box name needed.

Do NOT try `-r /remote/path.sock:7779` — released et (6.2.x) has no
socket-path tunnel syntax (it fails with a bogus "port range" error);
that syntax only exists in unreleased master. Plain TCP `-r 7779:7779`
works but supports only a single client box (last/first bind wins).

### ssh

Pick a short unique name per client box (e.g. `mbp`). In the box's
`~/.ssh/config`:

```
Host thatbox
	RemoteForward /home/pasky/.pi-clip/mbp.sock localhost:7779
	SetEnv LC_PI_CLIP=mbp
```

`LC_*` is used because stock Debian sshd has `AcceptEnv LANG LC_*` — no
server-side sshd change needed for the env var.

### mosh

Cannot work — mosh forwards nothing. Ctrl+V degrades to a silent no-op.

## Ctrl+V resolution order

1. `~/.pi-clip/by-tty/<tty>.sock` of the tmux client with the newest
   `client_activity` (the keypress itself bumps it).
2. Every `~/.pi-clip/*.sock` and `~/.pi-clip/by-tty/*.sock`, newest first.
3. Legacy `~/.pi-clip.sock`, then TCP `127.0.0.1:7779`.

Candidates are probed with a 300 ms connect timeout; dead/stale sockets are
skipped. Once a socket **accepts**, it is authoritative: an empty/imageless
response shows "No image on client clipboard" rather than falling through to
a different box's clipboard.

Env overrides: `PI_REMOTE_CLIP_DIR`, `PI_REMOTE_CLIP_SOCK` (legacy single
socket), `PI_REMOTE_CLIP_PORT`.

## Notes

- Non-PNG clipboard images (e.g. JPEG copied from a browser) are fine:
  pngpaste converts to PNG on output. The extension sniffs magic bytes
  (png/jpg/gif/webp) and rejects anything else.
- Empty clipboard: pngpaste exits non-zero writing an error to stderr; the
  plist's `StandardErrorPath` keeps that text off the socket so the
  extension sees a clean empty read.
- Bogus PNG gamma: pngpaste always re-encodes the pasteboard bitmap through
  AppKit/ImageIO (it never dumps the pasteboard's raw `public.png` flavor),
  and that path can emit a `gAMA` chunk with the *decoding* gamma
  (219998 = 1/0.45455) instead of the encoding gamma (≈45455 = 1/2.2).
  Gamma-aware viewers then "correct" for the inverted value and wash the
  image out — same failure mode as
  [this HN case](https://news.ycombinator.com/item?id=46403048). An encoding
  gamma > 1.0 is spec-legal but in practice always a writer bug (no real
  encoder emits one), so the extension splices such chunks out of pasted
  PNGs (pixel data untouched; sane `gAMA` values are kept; structurally
  broken PNGs are passed through unmodified).
- Multi-user remote boxes: unix sockets are used precisely so other local
  users cannot read your client clipboard (et's socket dir is 0700; keep
  `~/.pi-clip` at 0700).

## Silencing the startup shortcut-conflict warning

Because the extension registers `Ctrl+V`, which pi ships bound to the built-in
`app.clipboard.pasteImage`, pi prints a diagnostic on every startup:

```
Extension shortcut conflict: 'ctrl+v' is built-in shortcut for
app.clipboard.pasteImage and .../ssh-image-clipboard.ts. Using .../ssh-image-clipboard.ts.
```

The extension still wins ("Using .../ssh-image-clipboard.ts"), so this is
harmless — but noisy. On a headless box the built-in paste is a no-op anyway,
so just unbind it in the remote box's `~/.pi/agent/keybindings.json` to make
the conflict (and the warning) disappear:

```json
{
	"app.clipboard.pasteImage": []
}
```

## Tests

```bash
node test/ssh-image-clipboard.test.ts
```
