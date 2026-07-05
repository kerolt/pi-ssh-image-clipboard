/**
 * remote-image-paste: make Ctrl+V image paste work over ssh/et from client
 * machines (e.g. Macs), including multiple boxen attached to the same tmux.
 *
 * Transport: each client box serves its clipboard as PNG on its local
 * 127.0.0.1:7779 (launchd inetd-style + pngpaste) and reverse-tunnels it to a
 * per-box unix socket here:
 *   ssh -R /home/USER/.pi-clip/<box>.sock:localhost:7779   (+ SetEnv LC_PI_CLIP=<box>)
 *   et  -r PI_CLIP_SOCK:/CLIENT/HOME/.clipserve.sock   (unix socket on client;
 *       et creates a private per-connection socket here and exports PI_CLIP_SOCK)
 * A login hook symlinks ~/.pi-clip/by-tty/<tty>.sock -> <box>.sock so we can
 * resolve "which box is the user typing from" via tmux client activity.
 *
 * Socket resolution order (first *connectable* wins; dead sockets skipped):
 *   1. by-tty socket of the most-recently-active tmux client (the one that
 *      pressed Ctrl+V)
 *   2. all ~/.pi-clip/*.sock and ~/.pi-clip/by-tty/*.sock, newest first
 *      (et per-connection sockets live under /tmp/et_forward_sock_XXXXXX/
 *      and are only reachable via their by-tty symlink)
 *   3. legacy single socket ~/.pi-clip.sock, then TCP 127.0.0.1:7779
 *
 * See remote-image-paste.mac-setup.md next to this file for client setup.
 *
 * Registers only on headless Linux (no DISPLAY/WAYLAND_DISPLAY), where pi's
 * built-in image paste is a guaranteed no-op anyway — so local/desktop pi
 * sessions keep the stock handler.
 */
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLIP_DIR = process.env.PI_REMOTE_CLIP_DIR ?? path.join(os.homedir(), ".pi-clip");
const LEGACY_SOCK = process.env.PI_REMOTE_CLIP_SOCK ?? path.join(os.homedir(), ".pi-clip.sock");
const TCP_PORT = Number(process.env.PI_REMOTE_CLIP_PORT ?? 7779);
const CONNECT_TIMEOUT_MS = 300; // localhost: either the tunnel is there or it isn't
const INACTIVITY_TIMEOUT_MS = 2000; // while streaming image bytes over the WAN

type Target = string | number; // unix socket path | localhost TCP port

/** null = target dead/unreachable; empty buffer = connected but nothing served */
function fetchFrom(target: Target): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let connected = false;
		const sock = typeof target === "number" ? net.connect(target, "127.0.0.1") : net.connect(target);
		const finish = (value: Buffer | null) => {
			sock.destroy();
			resolve(value);
		};
		sock.setTimeout(CONNECT_TIMEOUT_MS);
		sock.on("connect", () => {
			connected = true;
			sock.setTimeout(INACTIVITY_TIMEOUT_MS);
		});
		sock.on("timeout", () => finish(connected ? Buffer.concat(chunks) : null));
		sock.on("error", () => finish(null));
		sock.on("data", (chunk) => chunks.push(chunk));
		sock.on("close", () => finish(connected ? Buffer.concat(chunks) : null));
	});
}

/** Socket of the tmux client that most recently sent input (i.e. this Ctrl+V). */
function activeTmuxClientSocket(): string | null {
	if (!process.env.TMUX) return null;
	try {
		const out = execFileSync("tmux", ["list-clients", "-F", "#{client_activity} #{client_tty}"], {
			timeout: 1000,
		}).toString("utf-8");
		const best = out
			.trim()
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts.length === 2)
			.sort((a, b) => Number(b[0]) - Number(a[0]))[0];
		if (!best) return null;
		const sock = path.join(CLIP_DIR, "by-tty", `${path.basename(best[1])}.sock`);
		return fs.existsSync(sock) ? sock : null; // existsSync follows symlinks
	} catch {
		return null;
	}
}

function candidateTargets(): Target[] {
	const candidates: Target[] = [];
	const byTty = activeTmuxClientSocket();
	if (byTty) candidates.push(byTty);
	const scanned: { p: string; mtime: number }[] = [];
	for (const dir of [CLIP_DIR, path.join(CLIP_DIR, "by-tty")]) {
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith(".sock")) continue;
				const p = path.join(dir, f);
				try {
					scanned.push({ p, mtime: fs.statSync(p).mtimeMs }); // follows symlinks; dangling ones throw
				} catch {
					// dangling by-tty symlink or vanished socket: skip
				}
			}
		} catch {
			// dir doesn't exist: fine
		}
	}
	scanned.sort((a, b) => b.mtime - a.mtime);
	candidates.push(...scanned.map((e) => e.p));
	if (fs.existsSync(LEGACY_SOCK)) candidates.push(LEGACY_SOCK);
	candidates.push(TCP_PORT);
	return [...new Set(candidates)];
}

function sniffImageExt(data: Buffer): string | null {
	if (data.length < 12) return null;
	if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
	if (data.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
	if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP")
		return "webp";
	return null;
}

export default function (pi: ExtensionAPI) {
	if (process.platform !== "linux" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
		return; // built-in image paste can work here; don't shadow it
	}

	pi.registerShortcut("ctrl+v", {
		description: "Paste image from client-side clipboard via reverse tunnel",
		handler: async (ctx) => {
			for (const target of candidateTargets()) {
				const data = await fetchFrom(target);
				if (data === null) continue; // dead tunnel/stale socket: try next
				// Connected — this box's clipboard is authoritative; don't fall
				// through to another box just because this one has no image.
				const ext = data.length > 0 ? sniffImageExt(data) : null;
				if (!ext) {
					ctx.ui.notify("No image on client clipboard (tunnel is up)", "warning");
					return;
				}
				const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.${ext}`);
				fs.writeFileSync(file, data);
				ctx.ui.pasteToEditor(file);
				return;
			}
			// No live tunnel at all (e.g. connected via mosh): silent, like the
			// stock handler on a headless box.
		},
	});
}
