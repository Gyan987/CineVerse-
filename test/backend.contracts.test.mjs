import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServer, extractDocxText, extractFdxText, extractPdfText, parseUpload } from '../server.mjs';

async function runningServer(env = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cineverse-contract-'));
  const server = createServer({ dbPath: path.join(directory, 'cineverse.sqlite'), storageDir: directory, env: { ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(url, options = {}) {
        const response = await fetch(`${base}${url}`, {
          ...options,
          headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('json') ? JSON.parse(bytes.toString('utf8')) : bytes;
        return { response, payload };
      },
    };
  };
  return { server, directory, client };
}

async function closeRunning(running) {
  await running.server.shutdown();
  await rm(running.directory, { recursive: true, force: true });
}

test('demo sessions are isolated and never replace a signed-in account', async () => {
  const running = await runningServer({ CINEVERSE_DEMO_ENABLED: 'true' });
  try {
    const first = running.client();
    const second = running.client();
    const a = await first.request('/api/auth/demo', { method: 'POST', body: '{}' });
    const b = await second.request('/api/auth/demo', { method: 'POST', body: '{}' });
    assert.equal(a.response.status, 201);
    assert.equal(b.response.status, 201);
    assert.equal(a.payload.user.demo, true);
    assert.notEqual(a.payload.user.id, b.payload.user.id);
    const repeat = await first.request('/api/auth/demo', { method: 'POST', body: '{}' });
    assert.equal(repeat.response.status, 200);
    assert.equal(repeat.payload.projectId, a.payload.projectId);

    const normal = running.client();
    await normal.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'normal@example.test', password: 'password123' }) });
    const refused = await normal.request('/api/auth/demo', { method: 'POST', body: '{}' });
    assert.equal(refused.response.status, 409);
    const me = await normal.request('/api/auth/me');
    assert.equal(me.payload.user.email, 'normal@example.test');
  } finally {
    await closeRunning(running);
  }
});

test('project settings, memories, scoped glossary entries, and suggestion drafts persist safely', async () => {
  const running = await runningServer({ CINEVERSE_AI_PROVIDER: 'demo' });
  try {
    const client = running.client();
    await client.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'settings@example.test', password: 'password123' }) });
    const created = await client.request('/api/projects', { method: 'POST', body: JSON.stringify({
      title: 'Settings', sourceLanguage: 'en', targetLanguage: 'es', translationMode: 'cinematic', contextDepth: 'deep',
      customInstructions: 'Keep the pauses.', adaptation: 'retain', sourceText: 'INT. ROOM - NIGHT\n\nMARA\nThe last train doesn\'t wait for anyone.',
    }) });
    assert.equal(created.response.status, 201);
    const projectId = created.payload.project.id;
    assert.equal(created.payload.project.translationMode, 'cinematic');
    const patched = await client.request(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ contextDepth: 'shallow', adaptation: 'review' }) });
    assert.equal(patched.payload.project.contextDepth, 'shallow');
    assert.equal(patched.payload.project.adaptation, 'review');
    const sceneId = created.payload.scenes[0].id;
    const memory = await client.request(`/api/projects/${projectId}/memories`, { method: 'POST', body: JSON.stringify({ sourceText: 'last train', targetText: 'último tren', sceneId }) });
    assert.equal(memory.response.status, 201);
    const duplicate = await client.request(`/api/projects/${projectId}/memories`, { method: 'POST', body: JSON.stringify({ sourceText: 'last train', targetText: 'último tren', sceneId }) });
    assert.equal(duplicate.payload.duplicate, true);
    const global = await client.request(`/api/projects/${projectId}/glossary`, { method: 'POST', body: JSON.stringify({ sourceTerm: 'platform', targetTerm: 'andén', category: 'Terminology' }) });
    assert.equal(global.response.status, 201);
    const scoped = await client.request(`/api/projects/${projectId}/glossary`, { method: 'POST', body: JSON.stringify({ sourceTerm: 'platform', targetTerm: 'muelle', sceneId, category: 'Narrative continuity' }) });
    assert.equal(scoped.response.status, 201);
    assert.equal(scoped.payload.entry.sceneId, sceneId);
    const segment = created.payload.segments.find(item => item.type === 'dialogue');
    const before = await client.request(`/api/projects/${projectId}/segments/${segment.id}`);
    const suggestion = await client.request(`/api/projects/${projectId}/segments/${segment.id}/suggest`, { method: 'POST', body: JSON.stringify({ alternative: true }) });
    assert.equal(suggestion.response.status, 200);
    assert.equal(typeof suggestion.payload.translation, 'string');
    assert.equal(suggestion.payload.demo, true);
    assert.ok(suggestion.payload.warnings.some(warning => /human review/i.test(warning)));
    const after = await client.request(`/api/projects/${projectId}/segments/${segment.id}`);
    assert.equal(after.payload.segment.translation, before.payload.segment.translation);
    assert.ok(Array.isArray(after.payload.context.memories));
  } finally {
    await closeRunning(running);
  }
});

test('known and unknown demo language pairs are explicit', async () => {
  const running = await runningServer({ CINEVERSE_AI_PROVIDER: 'demo' });
  try {
    const client = running.client();
    await client.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'language@example.test', password: 'password123' }) });
    const known = await client.request('/api/translate', { method: 'POST', body: JSON.stringify({ text: 'The first frame is always a promise.', sourceLanguage: 'en', targetLanguage: 'es' }) });
    assert.equal(known.payload.translation, 'El primer fotograma siempre es una promesa.');
    assert.equal(known.payload.untranslated, false);
    const unknown = await client.request('/api/translate', { method: 'POST', body: JSON.stringify({ text: 'A new sentence.', sourceLanguage: 'en', targetLanguage: 'fr' }) });
    assert.equal(unknown.payload.untranslated, true);
    assert.equal(unknown.payload.translation, 'A new sentence.');
    assert.match(unknown.payload.warnings[0], /human review/i);
  } finally {
    await closeRunning(running);
  }
});

test('arbitrary uploaded English-to-Spanish screenplay text gets a labelled demo draft', async () => {
  const running = await runningServer({ CINEVERSE_AI_PROVIDER: 'demo' });
  try {
    const client = running.client();
    await client.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'arbitrary-demo@example.test', password: 'password123' }) });
    const created = await client.request('/api/projects', { method: 'POST', body: JSON.stringify({
      title: 'Arbitrary demo screenplay',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceText: 'INT. SMALL ROOM - NIGHT\n\nA stranger enters the room.\n\nMARA\nI don\'t know what is happening.',
    }) });
    assert.equal(created.response.status, 201);
    const projectId = created.payload.project.id;
    const translated = await client.request(`/api/projects/${projectId}/translate?sync=true`, { method: 'POST', body: JSON.stringify({ sync: true }) });
    assert.equal(translated.response.status, 200);
    assert.equal(translated.payload.job.status, 'completed');
    assert.equal(translated.payload.job.result.demoFallback, true);
    assert.ok(translated.payload.job.result.results.some(result => result.translated && result.demo));
    assert.ok(translated.payload.job.result.warnings.some(warning => /DEMO|human review/i.test(warning)));

    const bundle = await client.request(`/api/projects/${projectId}`);
    const drafts = bundle.payload.segments.filter(segment => ['action', 'dialogue'].includes(segment.type));
    assert.ok(drafts.length > 0);
    assert.ok(drafts.every(segment => typeof segment.translation === 'string' && segment.translation.trim()));
    assert.ok(drafts.some(segment => segment.translation !== segment.sourceText));
    assert.ok(drafts.every(segment => segment.approved === false));
  } finally {
    await closeRunning(running);
  }
});

test('Hindi-to-English scene-less upload gets a visible demo draft', async () => {
  const running = await runningServer({ CINEVERSE_AI_PROVIDER: 'demo' });
  try {
    const client = running.client();
    await client.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'hindi-demo@example.test', password: 'password123' }) });
    const created = await client.request('/api/projects', { method: 'POST', body: JSON.stringify({
      title: 'Kabir scene-less upload',
      sourceLanguage: 'hi',
      targetLanguage: 'en',
      sourceText: 'कबीर:तू यहाँ क्यों आया है, आरव?\n\nआरव:नहीं।मुझे लगता था तू मेरा दोस्त है।',
    }) });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.scenes.length, 0);
    const translated = await client.request(`/api/projects/${created.payload.project.id}/translate?sync=true`, { method: 'POST', body: JSON.stringify({ sync: true }) });
    assert.equal(translated.response.status, 200);
    assert.equal(translated.payload.job.status, 'completed');
    const bundle = await client.request(`/api/projects/${created.payload.project.id}`);
    assert.ok(bundle.payload.segments.every(segment => typeof segment.translation === 'string' && segment.translation.trim()));
    assert.ok(bundle.payload.segments.some(segment => segment.translation.includes('Why did you come here')));
    assert.ok(translated.payload.job.result.warnings.some(warning => /DEMO|human review/i.test(warning)));
  } finally {
    await closeRunning(running);
  }
});

test('binary and scanned-PDF parsers reject unsafe or unorderable input clearly', () => {
  assert.throws(() => parseUpload({ filename: 'bad.docx', data: Buffer.from('not a zip') }), /valid ZIP signature/);
  assert.throws(() => extractPdfText(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')), /OCR_REQUIRED/);
  assert.throws(() => extractPdfText(Buffer.from('%PDF-1.7\n(unsafely sampled) Tj')), /ordered text object/);
});

test('DOCX and FDX exports are real structured documents with untranslated markers', async () => {
  const running = await runningServer({ CINEVERSE_AI_PROVIDER: 'demo' });
  try {
    const client = running.client();
    await client.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'exports@example.test', password: 'password123' }) });
    const created = await client.request('/api/projects', { method: 'POST', body: JSON.stringify({ title: 'Binary', sourceText: 'INT. ROOM - NIGHT\n\nMARA (V.O.)\nUnknown line.' }) });
    const projectId = created.payload.project.id;
    const docx = await client.request(`/api/projects/${projectId}/export?format=docx`);
    assert.equal(docx.response.status, 200);
    assert.equal(docx.payload.subarray(0, 4).toString('ascii'), 'PK\x03\x04');
    assert.match(extractDocxText(docx.payload), /UNTRANSLATED/);
    assert.match(extractDocxText(docx.payload), /MARA \(V\.O\.\)/);
    const fdx = await client.request(`/api/projects/${projectId}/export?format=fdx`);
    assert.equal(fdx.response.status, 200);
    assert.match(fdx.payload.toString('utf8'), /<FinalDraft/);
    assert.match(extractFdxText(fdx.payload), /UNTRANSLATED/);
  } finally {
    await closeRunning(running);
  }
});

test('source file deletion is private, role-protected, and cascades parsed content', async () => {
  const running = await runningServer({ CINEVERSE_AI_PROVIDER: 'demo' });
  try {
    const owner = running.client();
    await owner.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'file-owner@example.test', password: 'password123' }) });
    const created = await owner.request('/api/projects', { method: 'POST', body: JSON.stringify({ title: 'Private', sourceText: 'INT. ROOM - DAY\n\nMARA\nHello.' }) });
    const projectId = created.payload.project.id;
    const fileId = created.payload.sourceFiles[0].id;
    const other = running.client();
    await other.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'file-other@example.test', password: 'password123' }) });
    const forbidden = await other.request(`/api/projects/${projectId}/files/${fileId}`, { method: 'DELETE' });
    assert.equal(forbidden.response.status, 403);
    const removed = await owner.request(`/api/projects/${projectId}/files/${fileId}`, { method: 'DELETE' });
    assert.equal(removed.response.status, 200);
    const bundle = await owner.request(`/api/projects/${projectId}`);
    assert.equal(bundle.payload.segments.length, 0);
    await assert.rejects(stat(path.join(running.directory, 'uploads', projectId, `${fileId}.fountain`)));
  } finally {
    await closeRunning(running);
  }
});
