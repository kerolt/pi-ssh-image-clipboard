/**
 * Headless tests for the ssh-image-clipboard extension.
 *
 * The extension has only a type-only import from pi, so it loads fine with
 * node's TypeScript type stripping. On node < 23 that needs a flag, so this
 * test re-execs itself with --experimental-strip-types when necessary.
 *
 * Run:  node test/ssh-image-clipboard.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.join(HERE, "..", "extensions", "ssh-image-clipboard.ts");

// --- fixture env: MUST be set before the extension module is imported anywhere
// (module-level constants bake in PI_REMOTE_CLIP_* at import time; without this
// the tests would probe the real ~/.pi-clip and hit live tunnels)
const CLIP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sic-test-"));
fs.mkdirSync(path.join(CLIP_DIR, "by-tty"));
process.env.PI_REMOTE_CLIP_DIR = CLIP_DIR;
process.env.PI_REMOTE_CLIP_SOCK = path.join(CLIP_DIR, "legacy-nonexistent.sock");
process.env.PI_REMOTE_CLIP_PORT = "1"; // connect always refused: TCP fallback stays inert
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
delete process.env.TMUX; // force fallback scan; tmux-dependent path needs a live tmux

// --- self re-exec with type stripping if needed -----------------------------
async function canImportTs() {
	try {
		await import(EXT_PATH);
		return true;
	} catch (err) {
		return err?.code !== "ERR_UNKNOWN_FILE_EXTENSION" && err?.code !== "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING";
	}
}
if (!process.env.__SIC_TEST_CHILD && !(await canImportTs())) {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, __SIC_TEST_CHILD: "1" },
	});
	process.exit(r.status ?? 1);
}

// --- fixture -----------------------------------------------------------------

const extMod = await import(EXT_PATH);
const extension = extMod.default;
const { sanitizePng } = extMod;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG chunk with dummy CRC (sanitizePng doesn't verify CRCs). */
function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}
function gamaChunk(value) {
	const d = Buffer.alloc(4);
	d.writeUInt32BE(value);
	return pngChunk("gAMA", d);
}
function pngWith(...chunks) {
	return Buffer.concat([
		PNG_SIG,
		pngChunk("IHDR", Buffer.alloc(13)),
		...chunks,
		pngChunk("IDAT", Buffer.alloc(10, 7)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}
function pngChunkTypes(buf) {
	const types = [];
	for (let off = 8; off + 12 <= buf.length; ) {
		const len = buf.readUInt32BE(off);
		types.push(buf.subarray(off + 4, off + 8).toString("latin1"));
		off += 12 + len;
	}
	return types;
}

function loadHandler() {
	const shortcuts = [];
	extension({ registerShortcut: (key, opts) => shortcuts.push({ key, opts }) });
	return shortcuts;
}

function makeCtx() {
	const events = { notified: null, pasted: null };
	return {
		events,
		ctx: {
			ui: {
				notify: (msg) => (events.notified = msg),
				pasteToEditor: (text) => (events.pasted = text),
			},
		},
	};
}

function listenUnix(sockPath, payload) {
	const srv = net.createServer((s) => s.end(payload));
	return new Promise((resolve) => srv.listen(sockPath, () => resolve(srv)));
}

function closeServer(srv) {
	return new Promise((resolve) => srv.close(resolve));
}

function cleanDir() {
	for (const sub of ["", "by-tty"]) {
		const dir = path.join(CLIP_DIR, sub);
		for (const f of fs.readdirSync(dir)) {
			const p = path.join(dir, f);
			if (!fs.lstatSync(p).isDirectory()) fs.unlinkSync(p);
		}
	}
}

// --- tests -------------------------------------------------------------------

test("sanitizePng strips inverted gAMA (gamma > 1) and nothing else", () => {
	const bogus = pngWith(gamaChunk(219998));
	const fixed = sanitizePng(bogus);
	assert.deepEqual(pngChunkTypes(fixed), ["IHDR", "IDAT", "IEND"]);
	assert.deepEqual(sanitizePng(fixed), fixed); // idempotent
	// IDAT bytes untouched
	assert.ok(fixed.includes(Buffer.alloc(10, 7)));
});

test("sanitizePng keeps a correct encoding gAMA (~0.45455)", () => {
	const ok = pngWith(gamaChunk(45455));
	assert.deepEqual(sanitizePng(ok), ok);
});

test("sanitizePng leaves non-PNG and malformed data untouched", () => {
	const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
	assert.deepEqual(sanitizePng(jpg), jpg);
	const truncated = pngWith(gamaChunk(219998)).subarray(0, 30); // cut mid-IHDR
	assert.deepEqual(sanitizePng(truncated), truncated);
	// bogus gAMA is present and parseable, but the stream never reaches IEND:
	// must stay untouched (no splicing of structurally broken PNGs)
	const full = pngWith(gamaChunk(219998));
	const midIdat = full.subarray(0, full.length - 20); // cut inside IDAT
	assert.deepEqual(sanitizePng(midIdat), midIdat);
	const noIend = full.subarray(0, full.length - 12); // IEND chunk missing entirely
	assert.deepEqual(sanitizePng(noIend), noIend);
});

test("does not register when a display is present", () => {
	process.env.DISPLAY = ":0";
	try {
		assert.equal(loadHandler().length, 0);
	} finally {
		delete process.env.DISPLAY;
	}
});

test("registers ctrl+v on headless linux", () => {
	const shortcuts = loadHandler();
	assert.equal(shortcuts.length, process.platform === "linux" ? 1 : 0);
	if (shortcuts.length) assert.equal(shortcuts[0].key, "ctrl+v");
});

if (process.platform === "linux") {
	test("pastes temp file path from a live socket", async () => {
		const srv = await listenUnix(path.join(CLIP_DIR, "boxa.sock"), PNG);
		try {
			const { events, ctx } = makeCtx();
			await loadHandler()[0].opts.handler(ctx);
			assert.equal(events.notified, null);
			assert.match(events.pasted, /pi-clipboard-.*\.png$/);
			assert.deepEqual([...fs.readFileSync(events.pasted).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
			fs.unlinkSync(events.pasted);
		} finally {
			await closeServer(srv);
			cleanDir();
		}
	});

	test("skips a dead socket file and uses the live one", async () => {
		const srv = await listenUnix(path.join(CLIP_DIR, "live.sock"), PNG);
		try {
			// stale "socket": plain file, newer than the live one
			const stale = path.join(CLIP_DIR, "stale.sock");
			fs.writeFileSync(stale, "");
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(stale, future, future);
			const { events, ctx } = makeCtx();
			await loadHandler()[0].opts.handler(ctx);
			assert.match(events.pasted ?? "", /pi-clipboard-/);
			fs.unlinkSync(events.pasted);
		} finally {
			await closeServer(srv);
			cleanDir();
		}
	});

	test("finds et-style sockets only reachable via by-tty symlink", async () => {
		const etDir = fs.mkdtempSync(path.join(os.tmpdir(), "sic-et-"));
		const srv = await listenUnix(path.join(etDir, "sock"), PNG);
		try {
			fs.symlinkSync(path.join(etDir, "sock"), path.join(CLIP_DIR, "by-tty", "5.sock"));
			fs.symlinkSync(path.join(etDir, "gone"), path.join(CLIP_DIR, "by-tty", "6.sock")); // dangling
			const { events, ctx } = makeCtx();
			await loadHandler()[0].opts.handler(ctx);
			assert.match(events.pasted ?? "", /pi-clipboard-/);
			fs.unlinkSync(events.pasted);
		} finally {
			await closeServer(srv);
			cleanDir();
			fs.rmSync(etDir, { recursive: true, force: true });
		}
	});

	test("pasted file has bogus gAMA stripped", async () => {
		const srv = await listenUnix(path.join(CLIP_DIR, "boxa.sock"), pngWith(gamaChunk(219998)));
		try {
			const { events, ctx } = makeCtx();
			await loadHandler()[0].opts.handler(ctx);
			assert.match(events.pasted ?? "", /pi-clipboard-.*\.png$/);
			assert.ok(!fs.readFileSync(events.pasted).includes(Buffer.from("gAMA", "latin1")));
			fs.unlinkSync(events.pasted);
		} finally {
			await closeServer(srv);
			cleanDir();
		}
	});

	test("warns when tunnel is up but clipboard is empty or non-image", async () => {
		const srv = await listenUnix(path.join(CLIP_DIR, "boxa.sock"), Buffer.from("No image data found\n"));
		try {
			const { events, ctx } = makeCtx();
			await loadHandler()[0].opts.handler(ctx);
			assert.equal(events.pasted, null);
			assert.match(events.notified ?? "", /No image/);
		} finally {
			await closeServer(srv);
			cleanDir();
		}
	});

	test("stays silent when no tunnel is reachable", async () => {
		const { events, ctx } = makeCtx();
		await loadHandler()[0].opts.handler(ctx);
		assert.equal(events.pasted, null);
		assert.equal(events.notified, null);
	});
}

process.on("exit", () => fs.rmSync(CLIP_DIR, { recursive: true, force: true }));
