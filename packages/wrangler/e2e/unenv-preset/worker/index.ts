import assert from "node:assert";

// List all the test functions.
// The test can be executing by fetching the `/${testName}` url.
export const TESTS: Record<string, () => void> = {
	testCryptoGetRandomValues,
	testImplementsBuffer,
	testNodeCompatModules,
	testUtilImplements,
	testPath,
	testDns,
	testTimers,
	testNet,
	testTls,
	testDebug,
	testHttp,
	testHttps,
};

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/ping":
				// `/ping` check that the server is online
				return new Response("pong");

			case "/flag": {
				// `/flag?name=<flag_name>)` returns value of the runtime flag
				const flagName = url.searchParams.get("name");

				return Response.json(
					flagName
						? getRuntimeFlagValue(flagName) ?? "undefined"
						: "The request is missing the `name` query parameter"
				);
			}

			default: {
				// `/<test name>` executes the test or returns an html list of tests when not found
				const testName = url.pathname.slice(1);
				const test = TESTS[testName];
				if (!test) {
					return generateTestListResponse(testName);
				}

				try {
					await test();
					return new Response("passed");
				} catch (e) {
					return new Response(`failed\n${e}`);
				}
			}
		}
	},
};

function getRuntimeFlagValue(name: string): boolean | undefined {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { compatibilityFlags } = (globalThis as any).Cloudflare;
	return compatibilityFlags[name];
}

function generateTestListResponse(testName: string): Response {
	return new Response(
		`<h1>${testName ? `${testName} not found!` : `Pick a test to run`} </h1>
        <ul>
        ${Object.keys(TESTS)
					.map((name) => `<li><a href="/${name}">${name}</a></li>`)
					.join("")}
        </ul>`,
		{ headers: { "Content-Type": "text/html; charset=utf-8" } }
	);
}

async function testCryptoGetRandomValues() {
	const crypto = await import("node:crypto");

	const array = new Uint32Array(10);
	crypto.getRandomValues(array);
	assert.strictEqual(array.length, 10);
	assert(array.every((v) => v >= 0 && v <= 0xff_ff_ff_ff));
}

async function testImplementsBuffer() {
	const encoder = new TextEncoder();
	const buffer = await import("node:buffer");
	const Buffer = buffer.Buffer;
	assert.strictEqual(buffer.isAscii(encoder.encode("hello world")), true);
	assert.strictEqual(buffer.isUtf8(encoder.encode("Yağız")), true);
	assert.strictEqual(buffer.btoa("hello"), "aGVsbG8=");
	assert.strictEqual(buffer.atob("aGVsbG8="), "hello");
	{
		const dest = buffer.transcode(
			Buffer.from([
				0x74, 0x00, 0x1b, 0x01, 0x73, 0x00, 0x74, 0x00, 0x20, 0x00, 0x15, 0x26,
			]),
			"ucs2",
			"utf8"
		);
		assert.strictEqual(
			dest.toString(),
			Buffer.from("těst ☕", "utf8").toString()
		);
	}
	assert.ok(new buffer.File([], "file"));
	assert.ok(new buffer.Blob([]));
	assert.strictEqual(typeof buffer.INSPECT_MAX_BYTES, "number");
	assert.strictEqual(typeof buffer.resolveObjectURL, "function");
}

async function testNodeCompatModules() {
	const module = await import("node:module");
	const require = module.createRequire("/");
	const modules = [
		"_tls_common",
		"_tls_wrap",
		"assert",
		"assert/strict",
		"buffer",
		"diagnostics_channel",
		"dns",
		"dns/promises",
		"events",
		"net",
		"path",
		"path/posix",
		"path/win32",
		"querystring",
		"stream",
		"stream/consumers",
		"stream/promises",
		"stream/web",
		"string_decoder",
		"timers",
		"timers/promises",
		"url",
		"util/types",
		"zlib",
	];
	for (const m of modules) {
		assert.strictEqual(await import(m), require(m));
	}
}

async function testUtilImplements() {
	const util = await import("node:util");
	const { types } = util;
	assert.strictEqual(types.isExternal("hello world"), false);
	assert.strictEqual(types.isAnyArrayBuffer(new ArrayBuffer(0)), true);
	assert.strictEqual(util.isArray([]), true);
	assert.strictEqual(util.isDeepStrictEqual(0, 0), true);
}

async function testPath() {
	const pathWin32 = await import("node:path/win32");
	assert.strictEqual(pathWin32.sep, "\\");
	assert.strictEqual(pathWin32.delimiter, ";");
	const pathPosix = await import("node:path/posix");
	assert.strictEqual(pathPosix.sep, "/");
	assert.strictEqual(pathPosix.delimiter, ":");
}

async function testDns() {
	const dns = await import("node:dns");
	await new Promise((resolve, reject) => {
		dns.resolveTxt("nodejs.org", (error, results) => {
			if (error) {
				reject(error);
				return;
			}
			assert.ok(Array.isArray(results[0]));
			assert.strictEqual(results.length, 1);
			assert.ok(results[0][0].startsWith("v=spf1"));
			resolve(null);
		});
	});

	const dnsPromises = await import("node:dns/promises");
	const results = await dnsPromises.resolveCaa("google.com");
	assert.ok(Array.isArray(results));
	assert.strictEqual(results.length, 1);
	assert.strictEqual(typeof results[0].critical, "number");
	assert.strictEqual(results[0].critical, 0);
	assert.strictEqual(results[0].issue, "pki.goog");
}

async function testTimers() {
	const timers = await import("node:timers");
	const timeout = timers.setTimeout(() => null, 1000);
	// active is deprecated and no more in the type
	(timers as unknown as { active: (t: NodeJS.Timeout) => void }).active(
		timeout
	);
	timers.clearTimeout(timeout);

	const timersPromises = await import("node:timers/promises");
	assert.strictEqual(await timersPromises.setTimeout(1, "timeout"), "timeout");
}

export async function testNet() {
	const net = await import("node:net");
	assert.strictEqual(typeof net, "object");
	assert.strictEqual(typeof net.createConnection, "function");
	assert.throws(() => net.createServer(), /not implemented/);
}

export async function testTls() {
	const tls = await import("node:tls");
	assert.strictEqual(typeof tls, "object");
	// @ts-expect-error Node types are wrong
	assert.strictEqual(typeof tls.convertALPNProtocols, "function");
}

export async function testDebug() {
	// @ts-expect-error "debug" is an unenv alias, not installed locally
	const debug = (await import("debug")).default;
	const logs: string[] = [];

	// Append all logs to the array instead of logging to console
	debug.log = (...args: string[]) =>
		logs.push(args.map((arg) => arg.toString()).join(" "));

	const exampleLog = debug("example");
	const testLog = exampleLog.extend("test");

	exampleLog("This is an example log");
	testLog("This is a test log");

	assert.deepEqual(logs, ["example This is an example log +0ms"]);
}

export async function testHttp() {
	const http = await import("http");

	const useNativeHttp = getRuntimeFlagValue("enable_nodejs_http_modules");

	if (useNativeHttp) {
		// Test the workerd implementation only
		assert.doesNotThrow(() => http.validateHeaderName("x-header"));
		assert.doesNotThrow(() => http.validateHeaderValue("x-header", "value"));
	} else {
		// Test the unenv polyfill only
		assert.throws(() => http.validateHeaderName("x-header"), /not implemented/);
		assert.throws(
			() => http.validateHeaderValue("x-header", "value"),
			/not implemented/
		);
	}

	assert.ok(http.METHODS.includes("GET"));
	assert.strictEqual(typeof http.get, "function");
	assert.strictEqual(typeof http.request, "function");
	assert.deepEqual(http.STATUS_CODES[404], "Not Found");
}

export async function testHttps() {
	const https = await import("https");

	assert.strictEqual(typeof https.Agent, "function");
	assert.strictEqual(typeof https.get, "function");
	assert.strictEqual(typeof https.globalAgent, "object");
	assert.strictEqual(typeof https.request, "function");
}
