import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  listActiveModelProfiles, listAdminChanges, listAuthoringAgents, listAuthoringSkills, listAuthoringDrafts,
  listModelProfileRevisions, listProviders, registerAuthoringAgent, registerAuthoringSkill,
  resolvePlatformSettings, saveModelProfileRevision,
} from '../../../packages/persistence/src/index.js';
import { validateResponse } from '@ehf/ui-contracts/validate';
import { buildControlApi } from '../../control-api/src/app.js';
import { importAgentBundle } from '../../control-api/src/agent-import.js';
import { buildApp } from '../src/app.js';

vi.mock('../../../packages/persistence/src/index.js', async original => ({
  ...await original<typeof import('../../../packages/persistence/src/index.js')>(),
  listActiveModelProfiles: vi.fn(), listAuthoringDrafts: vi.fn(), listAdminChanges: vi.fn(), listAuthoringAgents: vi.fn(),
  listAuthoringSkills: vi.fn(), listModelProfileRevisions: vi.fn(), listProviders: vi.fn(),
  registerAuthoringAgent: vi.fn(), registerAuthoringSkill: vi.fn(), resolvePlatformSettings: vi.fn(),
  saveModelProfileRevision: vi.fn(),
}));
vi.mock('../../control-api/src/agent-import.js', () => ({ importAgentBundle: vi.fn() }));

const tenantId = 'tenant_platform_test';
const token = 'edge-platform-authoring-test-token';
const principal = { subjectId: 'author', tenantId, actorType: 'human' as const,
  roles: ['Platform.Admin', 'Harness.Author'], source: 'local' as const };
const agent = { id: 'agent.test', name: 'Test agent', description: 'Test authoring contract',
  role: 'specialist', modelProfileId: 'analysis', runtimeTarget: 'local_http', version: '0.1.0',
  status: 'draft', prompt: 'Review the supplied evidence.', inputSchema: { type: 'object' },
  outputSchema: { type: 'object' }, caseWrites: [], skillIds: ['instruction.test'], source: { type: 'manual' } };
const instruction = { id: 'instruction.test', name: 'Evidence review', description: 'Review with citations',
  version: '0.1.0', status: 'draft', instructions: 'Use the supplied evidence.',
  allowedCapabilityIds: [], source: { type: 'manual' } };
const metadata = { digest: 'a'.repeat(64), createdAt: '2026-11-09T12:00:00Z', updatedAt: '2026-11-09T12:00:00Z' };
const agentRecord = { agent, ...metadata };
const instructionRecord = { skill: instruction, ...metadata };
const fixtures = JSON.parse(readFileSync(new URL('../../fincrime-host/docs/ui/contracts/fixtures/platform.json', import.meta.url), 'utf8'));
const { revisions: _revisions, ...profileRevision } = fixtures.modelProfiles[0];
let control: ReturnType<typeof buildControlApi>;
let bff: ReturnType<typeof buildApp>;
let headers: Record<string, string>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(listAuthoringDrafts).mockResolvedValue([]);
  vi.mocked(listAuthoringAgents).mockResolvedValue([agentRecord] as never);
  vi.mocked(listAuthoringSkills).mockResolvedValue([instructionRecord] as never);
  vi.mocked(registerAuthoringAgent).mockResolvedValue({ created: true, ...agentRecord } as never);
  vi.mocked(registerAuthoringSkill).mockResolvedValue({ created: true, ...instructionRecord } as never);
  vi.mocked(importAgentBundle).mockResolvedValue({ agent, skills: [instruction] } as never);
  for (const read of [listProviders, listActiveModelProfiles, listModelProfileRevisions, listAdminChanges, resolvePlatformSettings]) {
    vi.mocked(read).mockResolvedValue([]);
  }
  vi.mocked(saveModelProfileRevision).mockResolvedValue({ created: true, ...profileRevision });
  control = buildControlApi({ db: { query: vi.fn() } as never, contextStore: null,
    serviceGrants: [{ token, subjectId: 'edge', roles: ['Edge.Delegate'], tenantId }], env: { IDENTITY_PROVIDER: 'local_headers', DOMAINS_PATH: new URL('../../../domains', import.meta.url).pathname } });
  bff = buildApp({ env: { BFF_PUBLIC_ORIGIN: 'http://ui.test' },
    principalResolver: { source: 'local', resolve: async () => principal },
    upstream: async (service, method, path, actor, body) => {
      expect(service).toBe('control-api');
      const response = await control.inject({ method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS', url: path, headers: {
        authorization: `Bearer ${token}`, 'x-actor-id': actor.subjectId,
        'x-actor-roles': actor.roles.join(','), 'x-tenant-id': actor.tenantId, 'content-type': 'application/json',
      }, ...(body === undefined ? {} : { payload: JSON.stringify(body) ?? 'null' }) });
      return { status: response.statusCode, body: response.json() };
    } });
  const session = await bff.inject('/api/v1/session');
  headers = { origin: 'http://ui.test', cookie: String(session.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': session.json().csrfToken };
});
afterEach(async () => { await bff.close(); await control.close(); });

it.each([
  ['getAdminProviders', 'providers'], ['getAdminModelProfiles', 'model-profiles'],
  ['getAdminSettings', 'settings'], ['getAdminChangeLog', 'change-log'],
])('adapts the actual control API envelope for %s', async (operation, path) => {
  const response = await bff.inject(`/api/v1/admin/${path}`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ items: [], nextCursor: null });
  expect(validateResponse(operation!, 200, response.json()).valid).toBe(true);
});

it('projects canonical agent instructions into the existing browser registry contract', async () => {
  const response = await bff.inject('/api/v1/authoring/skills');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().items).toEqual([instructionRecord]);
  expect(validateResponse('getAuthoringSkills', 200, response.json()).valid).toBe(true);
});

it('renders populated administration records from the control API without losing revision history', async () => {
  vi.mocked(listProviders).mockResolvedValue(fixtures.providers);
  vi.mocked(listActiveModelProfiles).mockResolvedValue([profileRevision]);
  vi.mocked(listModelProfileRevisions).mockResolvedValue([profileRevision]);
  vi.mocked(resolvePlatformSettings).mockResolvedValue(fixtures.settings);
  vi.mocked(listAdminChanges).mockResolvedValue(fixtures.changeLog);
  for (const [operation, path] of [
    ['getAdminProviders', 'providers'], ['getAdminModelProfiles', 'model-profiles'],
    ['getAdminSettings', 'settings'], ['getAdminChangeLog', 'change-log'],
  ]) {
    const response = await bff.inject(`/api/v1/admin/${path}`);
    expect(response.statusCode, `${operation}: ${response.body}`).toBe(200);
    expect(response.json().items.length).toBeGreaterThan(0);
    expect(validateResponse(operation!, 200, response.json()).valid).toBe(true);
    if (operation === 'getAdminModelProfiles') expect(response.json().items[0].revisions).toEqual([profileRevision]);
  }
});

it.each([
  ['postAuthoringAgents', 'agents', agent, agentRecord],
  ['postAuthoringSkills', 'skills', instruction, instructionRecord],
])('acknowledges a successful %s without rejecting service creation metadata', async (operation, path, input, record) => {
  const response = await bff.inject({ method: 'POST', url: `/api/v1/authoring/${path}`, headers, payload: input });
  expect(response.statusCode, response.body).toBe(201);
  expect(response.json()).toEqual(record);
  expect(validateResponse(String(operation), 201, response.json()).valid).toBe(true);
});

it('adapts both the agent and instruction records returned by the real GitHub import route', async () => {
  const response = await bff.inject({ method: 'POST', url: '/api/v1/authoring/import/github', headers,
    payload: { url: 'https://github.com/example/agent' } });
  expect(response.statusCode, response.body).toBe(201);
  expect(response.json()).toEqual({ agent: agentRecord, skills: [instructionRecord] });
});

it.each([[true, 201], [false, 200]] as const)('preserves the model-profile creation flag %s as HTTP %s', async (created, status) => {
  vi.mocked(saveModelProfileRevision).mockResolvedValue({ created, ...profileRevision });
  const response = await bff.inject({ method: 'PUT', url: `/api/v1/admin/model-profiles/${profileRevision.profile.id}`, headers,
    payload: { profile: profileRevision.profile } });
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toEqual(profileRevision);
  expect(validateResponse('putAdminModelProfilesProfileId', status, response.json()).valid).toBe(true);
});

it('keeps invalid instruction records visible to response validation', async () => {
  vi.mocked(listAuthoringSkills).mockResolvedValue([{ ...instructionRecord, unexpected: true }] as never);
  const response = await bff.inject('/api/v1/authoring/skills');
  expect(response.statusCode).toBe(502);
  expect(response.json().error).toBe('bff.upstream_contract_invalid');
});

it("serves Process Studio draft and template pages from the actual control API envelopes", async () => {
  const empty = await bff.inject("/api/v1/authoring/drafts");
  expect(empty.statusCode, empty.body).toBe(200);
  expect(empty.json()).toMatchObject({ items: [], nextCursor: null });
  vi.mocked(listAuthoringDrafts).mockResolvedValue(fixtures.drafts);
  const populated = await bff.inject("/api/v1/authoring/drafts");
  expect(populated.statusCode, populated.body).toBe(200);
  expect(populated.json().items).toEqual(fixtures.drafts);
  const templates = await bff.inject("/api/v1/authoring/templates");
  expect(templates.statusCode, templates.body).toBe(200);
  expect(templates.json().items.length).toBeGreaterThan(0);
  expect(validateResponse("getAuthoringTemplates", 200, templates.json()).valid).toBe(true);
});
