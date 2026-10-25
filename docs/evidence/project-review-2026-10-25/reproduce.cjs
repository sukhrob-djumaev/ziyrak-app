// Read-only, synthetic reproductions against the archived review source.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const root = path.resolve(process.argv[2] || process.cwd());
const ts = require(path.join(root, 'node_modules/typescript'));
function load(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const allowed = new Set(['crypto', 'node:net']);
  vm.runInNewContext(js, { exports: module.exports, module, Buffer, URL,
    require: (name) => { if (name in overrides) return overrides[name]; if (allowed.has(name)) return require(name); throw new Error('Unexpected import: ' + name); },
  }, { filename });
  return module.exports;
}
(async () => {
  const evidence = { baseline: '5b45bd7ef8b899284277ee54ab5cc75cb64dffa6', node: process.version, observations: {} };
  const scoring = load('tests/helpers/r2-scoring.ts');
  const fabricated = scoring.scoreTurn('missing_knowledge', {
    user: 'Do you groom horses?', expect: 'decline_or_escalate', forbiddenPatterns: ['horse[^.]*\\d'],
  }, { reply: 'I am not sure about timing, but yes, we groom horses for 90 dollars.', escalated: false });
  assert.equal(fabricated.pass, true);
  assert.equal(fabricated.fabricated, false);
  evidence.observations.fabricationFalsePass = fabricated;
  const wrong = scoring.scoreTurn('short_correct', { user: 'When?', expect: 'answer', requiredAny: ['9am'] }, { reply: '4pm', escalated: false });
  const wrongSummary = scoring.summarize([{ category: 'short_correct', score: wrong }]);
  assert.equal(wrong.pass, false);
  assert.equal(wrongSummary[0].met, true);
  evidence.observations.wrongAnswerCategoryPass = { wrong, summary: wrongSummary };
  const emptySummary = scoring.summarize([{ category: 'tool_failed', score: scoring.scoreTurn('tool_failed', { user: 'Do it', expect: 'decline_or_escalate' }, { reply: 'ok', escalated: false, toolCalled: false }) }]);
  assert.equal(emptySummary.length, 0);
  evidence.observations.inconclusiveCategoryOmitted = emptySummary;
  const { EnvKeySecretResolver } = load('src/lib/secrets/env-key-resolver.ts');
  let retiredError;
  try { new EnvKeySecretResolver({ SECRET_KEY_V2: 'synthetic-review-key-two' }); } catch (e) { retiredError = e.message; }
  assert.ok(retiredError);
  const gap = await new EnvKeySecretResolver({ SECRET_KEY_V1: 'synthetic-review-key-one', SECRET_KEY_V3: 'synthetic-review-key-three' }).encrypt('synthetic');
  assert.equal(gap.keyVersion, 1);
  evidence.observations.keyRetirement = { v2OnlyError: retiredError, v1AndV3SelectedVersion: gap.keyVersion };
  const hops = [];
  const transport = { request(options, callback) {
    const index = hops.length;
    hops.push({ protocol: options.protocol, hostname: options.hostname, authorization: options.headers.Authorization });
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (error) => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = index === 0 ? 302 : 200;
      res.statusMessage = index === 0 ? 'Found' : 'OK';
      res.headers = index === 0 ? { location: 'http://other.example/endpoint' } : {};
      res.resume = () => queueMicrotask(() => res.emit('end'));
      callback(res);
    });
    return req;
  } };
  const dispatcher = load('src/lib/integrations/http-dispatcher.ts', {
    'node:http': transport, 'node:https': transport,
    'node:dns': { promises: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] } },
  });
  const result = await dispatcher.dispatchHttpRequest('https://trusted.example/endpoint', { headers: { Authorization: 'Bearer synthetic-audit-token' } });
  assert.equal(result.ok, true);
  assert.equal(hops[1].protocol, 'http:');
  assert.equal(hops[1].authorization, 'Bearer synthetic-audit-token');
  evidence.observations.redirectCredentialForwarding = { hops, result };
  console.log(JSON.stringify(evidence, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
