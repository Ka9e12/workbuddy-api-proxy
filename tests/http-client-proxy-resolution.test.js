import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Readable} from 'node:stream';
import {existsSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {routeCopilotFrontend} from '../src/routes/copilot-frontend.js';
import {copilotStore} from '../src/services/copilot/copilot-store.js';
import {readBody, request} from '../src/utils/http-client.js';

function snapshotProxyFile() {
	const exists = existsSync(copilotStore.proxyFile);
	return {
		exists,
		content: exists ? readFileSync(copilotStore.proxyFile, 'utf8') : null
	};
}

function restoreProxyFile(snapshot) {
	if (snapshot.exists) {
		writeFileSync(copilotStore.proxyFile, snapshot.content, 'utf8');
	} else {
		rmSync(copilotStore.proxyFile, {force: true});
	}
	copilotStore._loadProxy();
}

async function routeFrontend(method, url, body) {
	const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
	req.method = method;
	req.url = url;
	req.headers = {host: '127.0.0.1'};

	const result = {statusCode: undefined, headers: {}, body: ''};
	const res = {
		writeHead(statusCode, headers = {}) {
			result.statusCode = statusCode;
			result.headers = headers;
		},
		end(data = '') {
			result.body += data;
		}
	};

	await routeCopilotFrontend(req, res);
	return {
		...result,
		json: result.body ? JSON.parse(result.body) : null
	};
}

test('copilotFE proxy update persists proxy and TLS skip setting', async () => {
	const original = snapshotProxyFile();

	try {
		const response = await routeFrontend('POST', '/copilotFE/proxy', {
			proxy: 'http://127.0.0.1:7890',
			skip_tls_verify: true
		});

		assert.equal(response.statusCode, 200);
		assert.equal(response.json.proxy, 'http://127.0.0.1:7890');
		assert.equal(response.json.skip_tls_verify, true);
		assert.equal(copilotStore.getProxyUrl(), 'http://127.0.0.1:7890');
		assert.equal(copilotStore.getRejectUnauthorized(), false);

		const status = await routeFrontend('GET', '/copilotFE/status');
		assert.equal(status.statusCode, 200);
		assert.equal(status.json.proxy, 'http://127.0.0.1:7890');
		assert.equal(status.json.skip_tls_verify, true);
	} finally {
		restoreProxyFile(original);
	}
});

test('copilotFE proxy update clears TLS skip setting when unchecked', async () => {
	const original = snapshotProxyFile();

	try {
		const response = await routeFrontend('POST', '/copilotFE/proxy', {
			proxy: '',
			skip_tls_verify: false
		});

		assert.equal(response.statusCode, 200);
		assert.equal(response.json.proxy, null);
		assert.equal(response.json.skip_tls_verify, false);
		assert.equal(copilotStore.getProxyUrl(), null);
		assert.equal(copilotStore.getRejectUnauthorized(), true);
	} finally {
		restoreProxyFile(original);
	}
});

test('explicit invalid proxy config fails instead of falling back to direct request', async () => {
	await assert.rejects(
		request('https://example.com', {proxyUrl: 'http://[invalid-proxy', timeout: 100}),
		/Invalid proxy config/
	);
});

test('readBody times out stalled response bodies', async () => {
	const stream = new PassThrough();
	stream.write('partial');

	await assert.rejects(
		readBody(stream, 10),
		/Response body timeout/
	);
});
