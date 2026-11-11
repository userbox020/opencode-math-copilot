import test from 'node:test';
import assert from 'node:assert/strict';
import { normalPrompt, parseNormalEvents, pluginEnvironment } from '../run-normal.mjs';

const line = value => JSON.stringify(value);

test('[normal-use] final text and tool calls are captured without a typed JSON contract', () => {
  const stdout = [
    line({ type: 'step_start', sessionID: 'ses_test', part: { messageID: 'm1' } }),
    line({ type: 'tool_use', sessionID: 'ses_test', part: { messageID: 'm1', tool: 'execute', state: { input: { code: 'tools.math_search({ query: "Hanner" })' } } } }),
    line({ type: 'tool_use', sessionID: 'ses_test', part: { messageID: 'm1', tool: 'read' } }),
    line({ type: 'text', sessionID: 'ses_test', part: { messageID: 'm1', text: 'Here is the normal answer.' } }),
    line({ type: 'step_finish', sessionID: 'ses_test', part: { cost: 0.002, tokens: { input: 10, output: 5 } } }),
  ].join('\n');
  const parsed = parseNormalEvents(stdout);
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.final_text, 'Here is the normal answer.');
  assert.deepEqual(parsed.tools, ['execute', 'read']);
  assert.deepEqual(parsed.math_tools, ['math_search']);
  assert.equal(parsed.session_id, 'ses_test');
  assert.equal(parsed.usage.tokens, 15);
  assert.equal(parsed.usage.cost, 0.002);
});

test('[normal-use] provider errors and empty output fail closed', () => {
  const provider = parseNormalEvents(line({ type: 'error', error: { type: 'provider.quota', message: 'quota' } }));
  assert.equal(provider.status, 'operational_failure');
  assert.match(provider.error, /quota/);
  const empty = parseNormalEvents('');
  assert.equal(empty.status, 'extraction_failure');
});

test('[normal-use] plugin off uses the explicit disable hook; plugin on removes it', () => {
  const off = pluginEnvironment('plugin-off', { PATH: 'x', MATH_TOOLKIT_DISABLE: '0' });
  assert.equal(off.MATH_TOOLKIT_DISABLE, '1');
  const on = pluginEnvironment('plugin-on', { PATH: 'x', MATH_TOOLKIT_DISABLE: '1' });
  assert.equal(on.MATH_TOOLKIT_DISABLE, undefined);
  const minimal = pluginEnvironment('plugin-on-minimal', { PATH: 'x', MATH_TOOLKIT_TOOLSET: 'full' });
  assert.equal(minimal.MATH_TOOLKIT_DISABLE, undefined);
  assert.equal(minimal.MATH_TOOLKIT_TOOLSET, 'minimal');
});

test('[normal-use] prompt is free-form and read-only', () => {
  const prompt = normalPrompt({ prompt: 'Explain the result.' });
  assert.match(prompt, /Answer naturally in prose/);
  assert.match(prompt, /Do not modify repository files/);
});
