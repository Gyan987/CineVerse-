import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { aiServiceStatus, createAiService, createServer, parseScreenplay, parseUpload } from '../server.mjs';

test('screenplay parsing preserves scene and delivery context', () => {
  const parsed = parseScreenplay('EXT. PLATFORM - NIGHT\n\nMARA (V.O.)\nThe last train waits.');
  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.segments.find(segment => segment.type === 'dialogue').delivery, 'voice_over');
  assert.match(parsed.segments[0].stableId, /^seg_/);
});

test('FDX uploads are safely decoded into typed screenplay context', () => {
  const upload = parseUpload({
    filename: 'episode.fdx',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
      <FinalDraft DocumentType="Script" Version="5">
        <Content>
          <Paragraph Type="Scene Heading"><Text>EXT. PLATFORM - NIGHT</Text></Paragraph>
          <Paragraph Type="Character"><Text>MARA (V.O.)</Text></Paragraph>
          <Paragraph Type="Dialogue"><Text>The last train &amp; the rain.</Text></Paragraph>
        </Content>
      </FinalDraft>`),
  });
  const parsed = parseScreenplay(upload.text, { paragraphs: upload.paragraphs });
  assert.equal(upload.extension, '.fdx');
  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.segments.find(segment => segment.type === 'dialogue').delivery, 'voice_over');
  assert.equal(parsed.segments.find(segment => segment.type === 'dialogue').text, 'The last train & the rain.');
});

test('demo translation is explicit and provider-shaped', async () => {
  const service = createAiService({ env: { CINEVERSE_AI_PROVIDER: 'demo' } });
  const result = await service.translate({ text: 'platform', glossary: [{ sourceTerm: 'platform', targetTerm: 'andén' }] });
  assert.equal(service.provider, 'demo-fallback');
  assert.equal(result.provider, 'demo-fallback');
  assert.equal(result.demo, true);
  assert.equal(aiServiceStatus({ env: { CINEVERSE_AI_PROVIDER: 'demo' } }).configured, true);
});

test('HTTP API enforces project ownership and supports a demo translation job', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cineverse-test-'));
  const server = createServer({
    dbPath: path.join(directory, 'cineverse.sqlite'),
    storageDir: directory,
    env: { CINEVERSE_AI_PROVIDER: 'demo', CINEVERSE_AI_ALLOW_DEMO_FALLBACK: 'true' },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let ownerCookie = '';
  let otherCookie = '';
  const request = async (url, options = {}, cookie = '') => {
    const response = await fetch(`${base}${url}`, {
      ...options,
      headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    const setCookie = response.headers.get('set-cookie');
    return { response, payload: await response.json(), cookie: setCookie ? setCookie.split(';')[0] : cookie };
  };
  try {
    const owner = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'password123' }) });
    ownerCookie = owner.cookie;
    const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ title: 'Test', sourceText: 'INT. ROOM - DAY\n\nMARA\nHello.\n\nJONAH\nGoodbye.' }) }, ownerCookie);
    const other = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'other@example.test', password: 'password123' }) });
    otherCookie = other.cookie;
    const forbidden = await request(`/api/projects/${project.payload.project.id}`, {}, otherCookie);
    assert.equal(forbidden.response.status, 403);
    const dialogue = project.payload.segments.find(segment => segment.type === 'dialogue');
    const secondDialogue = project.payload.segments.filter(segment => segment.type === 'dialogue')[1];
    const initialValidation = await request(`/api/projects/${project.payload.project.id}/validation`, { method: 'POST', body: JSON.stringify({}) }, ownerCookie);
    assert.equal(initialValidation.response.status, 200);
    assert.ok(initialValidation.payload.issues.some(issue => issue.segmentId === secondDialogue.id));
    const scopedValidation = await request(`/api/projects/${project.payload.project.id}/validation`, { method: 'POST', body: JSON.stringify({ segmentIds: [dialogue.id] }) }, ownerCookie);
    assert.equal(scopedValidation.response.status, 200);
    const remainingValidation = await request(`/api/projects/${project.payload.project.id}/validation`, {}, ownerCookie);
    assert.ok(remainingValidation.payload.issues.some(issue => issue.segmentId === secondDialogue.id));
    const translated = await request(`/api/projects/${project.payload.project.id}/translate?sync=true`, { method: 'POST', body: JSON.stringify({ segmentIds: [dialogue.id], sync: true }) }, ownerCookie);
    assert.equal(translated.response.status, 200);
    assert.equal(translated.payload.job.status, 'completed');
    assert.equal(translated.payload.job.result.demoFallback, true);
    const approved = await request(`/api/projects/${project.payload.project.id}/segments/${dialogue.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }, ownerCookie);
    assert.equal(approved.response.status, 200);
    const protectedTranslation = await request(`/api/projects/${project.payload.project.id}/translate?sync=true`, { method: 'POST', body: JSON.stringify({ segmentIds: [dialogue.id], sync: true }) }, ownerCookie);
    assert.equal(protectedTranslation.response.status, 400);
    assert.equal(protectedTranslation.payload.code, 'no_segments');
    const exported = await request(`/api/projects/${project.payload.project.id}/exports`, { method: 'POST', body: JSON.stringify({ format: 'json' }) }, ownerCookie);
    assert.equal(exported.response.status, 201);
    const downloaded = await request(exported.payload.export.downloadUrl, {}, ownerCookie);
    assert.equal(downloaded.response.status, 200);
    assert.equal(downloaded.payload.project.id, project.payload.project.id);
    const deleted = await request(`/api/projects/${project.payload.project.id}`, { method: 'DELETE' }, ownerCookie);
    assert.equal(deleted.response.status, 200);
    const gone = await request(`/api/projects/${project.payload.project.id}`, {}, ownerCookie);
    assert.equal(gone.response.status, 404);
  } finally {
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
