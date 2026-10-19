import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'fs';
import {join} from 'path';
import {fileURLToPath} from 'url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('admin Claude Code guides document auth compatibility and model pass-through', () => {
    const codebuddyHtml = readFileSync(join(root, 'src/templates/codebuddy-admin.html'), 'utf8');
    const relayHtml = readFileSync(join(root, 'src/templates/relay-admin.html'), 'utf8');
    const copilotHtml = readFileSync(join(root, 'src/templates/copilot-admin.html'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');

    for (const html of [codebuddyHtml, relayHtml, copilotHtml]) {
        assert.match(html, /"ANTHROPIC_AUTH_TOKEN": "\$\{apiKeyPlain \|\| apiKeyMasked\}"/);
        assert.match(html, /ANTHROPIC_API_KEY/);
        assert.match(html, /模型名.*原样透传/);
        assert.match(html, /deepseek-v4-pro\[1m\]/);
        assert.doesNotMatch(html, /ANTHROPIC_CUSTOM_HEADERS/);
    }

    assert.doesNotMatch(codebuddyHtml, /自动映射到可用模型/);
    assert.doesNotMatch(readme, /ANTHROPIC_CUSTOM_HEADERS/);
});
