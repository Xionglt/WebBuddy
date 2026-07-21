#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  FileSkillCandidateStore,
  assertProposedSkill,
  assertSkillGenerationRequest,
  candidateIdForFingerprint,
  defaultSkillCandidateRoot,
  generationRequestId,
  skillCandidateFingerprint,
} from '../dist/skills/candidates/index.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-skill-candidate-store-'))
const traceDir = join(root, 'trace')
const candidateRoot = join(root, 'candidate-plane')
const now = () => new Date('2026-07-21T08:00:00.000Z')

try {
  await mkdir(traceDir, { recursive: true })
  const store = new FileSkillCandidateStore({ rootDir: candidateRoot, now })
  const request = generationRequestFixture()

  assert.equal(
    generationRequestId(request),
    generationRequestId({ ...request }),
    'the same bound evidence should produce the same request id',
  )
  assert.match(request.requestId, /^request_[a-f0-9]{24}$/)
  assert.equal(candidateIdForFingerprint('a'.repeat(64)), `candidate_${'a'.repeat(24)}`)
  assert.throws(() => candidateIdForFingerprint('not-a-fingerprint'), /INVALID_CANDIDATE_FINGERPRINT/)

  assert.equal(
    defaultSkillCandidateRoot({ WEB_BUDDY_SKILL_CANDIDATE_ROOT: candidateRoot }),
    resolve(candidateRoot),
  )
  assert.throws(
    () => new FileSkillCandidateStore({
      rootDir: join(root, 'project-skills', 'candidate-plane'),
      env: { WEB_BUDDY_PROJECT_SKILL_ROOTS: join(root, 'project-skills') },
    }),
    /CANDIDATE_STORE_OVERLAPS_SKILL_ROOT/,
  )
  assert.throws(
    () => new FileSkillCandidateStore({
      rootDir: join(root, 'candidate-parent'),
      env: { WEB_BUDDY_USER_SKILL_ROOTS: join(root, 'candidate-parent', 'user-skills') },
    }),
    /CANDIDATE_STORE_OVERLAPS_SKILL_ROOT/,
  )
  assert.throws(
    () => new FileSkillCandidateStore({
      rootDir: join(root, 'same-root'),
      env: { WEB_BUDDY_PROJECT_SKILL_ROOTS: join(root, 'same-root') },
    }),
    /CANDIDATE_STORE_OVERLAPS_SKILL_ROOT/,
  )
  const physicalSkillRoot = join(root, 'physical-project-skills')
  const candidateRootLink = join(root, 'candidate-root-link')
  await mkdir(physicalSkillRoot)
  await symlink(physicalSkillRoot, candidateRootLink)
  assert.throws(
    () => new FileSkillCandidateStore({
      rootDir: candidateRootLink,
      env: { WEB_BUDDY_PROJECT_SKILL_ROOTS: physicalSkillRoot },
    }),
    /CANDIDATE_STORE_OVERLAPS_SKILL_ROOT/,
  )

  const requestPath = await store.writeRequest(traceDir, request)
  assert.equal(requestPath, join(traceDir, 'skill-learning', 'requests', `${request.requestId}.json`))
  assert.deepEqual(await store.readRequest(requestPath), request)
  assert.equal(await store.writeRequest(traceDir, request), requestPath)
  assert.equal(
    await store.writeRequest(traceDir, { ...request, createdAt: '2026-07-21T08:00:01.000Z' }),
    requestPath,
  )
  assert.deepEqual(await store.readRequest(requestPath), request)
  assert.deepEqual(await jsonFiles(join(traceDir, 'skill-learning', 'requests')), [`${request.requestId}.json`])

  await assert.rejects(
    store.writeRequest(traceDir, { ...request, revision: request.revision + 1 }),
    /GENERATION_REQUEST_CONFLICT/,
  )
  const forgedRequest = {
    ...request,
    requestId: `request_${'f'.repeat(24)}`,
    sessionId: 'forged-request-session',
  }
  await assert.rejects(
    store.writeRequest(traceDir, forgedRequest),
    /INVALID_REQUEST_ID/,
  )
  await assert.rejects(
    store.writeRequest(join(traceDir, '..', 'trace-escape'), request),
    /TRACE_DIR_NOT_FOUND/,
  )

  const symlinkRequest = {
    ...request,
    requestId: generationRequestId({ ...request, sessionId: 'symlink-request-session' }),
    sessionId: 'symlink-request-session',
  }
  const outsideRequest = join(root, 'outside-request.json')
  await writeFile(outsideRequest, `${JSON.stringify(symlinkRequest, null, 2)}\n`, 'utf8')
  await symlink(
    outsideRequest,
    join(traceDir, 'skill-learning', 'requests', `${symlinkRequest.requestId}.json`),
  )
  await assert.rejects(
    store.writeRequest(traceDir, symlinkRequest),
    /UNSAFE_IMMUTABLE_TARGET/,
  )

  const candidate = candidateFixture(request)
  const firstCandidate = await store.writeCandidate(candidate)
  const duplicateCandidate = await store.writeCandidate(candidate)
  assert.equal(firstCandidate.path, join(candidateRoot, 'candidates', `${candidate.candidateId}.json`))
  assert.equal(firstCandidate.created, true)
  assert.equal(duplicateCandidate.created, false)
  assert.deepEqual(await store.readCandidate(candidate.candidateId), candidate)
  assert.deepEqual(await store.findCandidate(candidate.candidateId), candidate)
  assert.equal(await store.findCandidate(`candidate_${'f'.repeat(24)}`), undefined)
  assert.deepEqual(await store.listCandidates(), [candidate])

  await assert.rejects(
    store.writeCandidate({ ...candidate, createdAt: '2026-07-21T08:01:00.000Z' }),
    /SKILL_CANDIDATE_CONFLICT/,
  )
  await assert.rejects(
    store.writeCandidate({
      ...candidate,
      provenance: { ...candidate.provenance, runId: 'different-run' },
    }),
    /CANDIDATE_BINDING_MISMATCH/,
  )
  await assert.rejects(store.readCandidate('../escape'), /INVALID_CANDIDATE_ID/)

  const mismatchedCandidate = {
    ...candidate,
    candidateId: candidateIdForFingerprint('b'.repeat(64)),
    fingerprint: 'b'.repeat(64),
  }
  const mismatchedCandidatePath = join(
    candidateRoot,
    'candidates',
    `${mismatchedCandidate.candidateId}.json`,
  )
  await writeFile(mismatchedCandidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
  await assert.rejects(
    store.readCandidate(mismatchedCandidate.candidateId),
    /CANDIDATE_FILE_ID_MISMATCH/,
  )
  await rm(mismatchedCandidatePath)

  const tamperedFingerprint = {
    ...candidate,
    candidateId: candidateIdForFingerprint('b'.repeat(64)),
    fingerprint: 'b'.repeat(64),
  }
  const tamperedFingerprintPath = join(
    candidateRoot,
    'candidates',
    `${tamperedFingerprint.candidateId}.json`,
  )
  await writeFile(
    tamperedFingerprintPath,
    `${JSON.stringify(tamperedFingerprint, null, 2)}\n`,
    'utf8',
  )
  await assert.rejects(
    store.readCandidate(tamperedFingerprint.candidateId),
    /CANDIDATE_FINGERPRINT_MISMATCH/,
  )
  await rm(tamperedFingerprintPath)

  const receipt = receiptFixture(request, candidate)
  const firstReceipt = await store.writeReceipt(receipt)
  const duplicateReceipt = await store.writeReceipt(receipt)
  assert.equal(firstReceipt.path, join(candidateRoot, 'receipts', `${request.requestId}.json`))
  assert.equal(firstReceipt.created, true)
  assert.equal(duplicateReceipt.created, false)
  assert.deepEqual(await store.readReceipt(request.requestId), receipt)
  assert.equal(await store.readReceipt(`request_${'f'.repeat(24)}`), undefined)
  await assert.rejects(
    store.writeReceipt({ ...receipt, status: 'duplicate' }),
    /GENERATION_RECEIPT_CONFLICT/,
  )
  await assert.rejects(store.readReceipt('../escape'), /INVALID_REQUEST_ID/)

  const secondRequestId = `request_${'e'.repeat(24)}`
  const mismatchedReceiptPath = join(candidateRoot, 'receipts', `${secondRequestId}.json`)
  await writeFile(mismatchedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await assert.rejects(store.readReceipt(secondRequestId), /RECEIPT_FILE_ID_MISMATCH/)
  await rm(mismatchedReceiptPath)

  const ineligibleReceipt = {
    schemaVersion: 'skill-generation-receipt/v1',
    requestId: `request_${'d'.repeat(24)}`,
    processedAt: '2026-07-21T08:00:00.000Z',
    status: 'ineligible',
    candidateId: undefined,
    findings: [],
  }
  await assert.rejects(
    store.writeReceipt(ineligibleReceipt),
    /INVALID_SKILL_GENERATION_RECEIPT/,
  )

  const invalidRequestPath = join(traceDir, 'skill-learning', 'requests', 'invalid.json')
  await writeFile(invalidRequestPath, JSON.stringify({ ...request, unexpected: true }), 'utf8')
  await assert.rejects(store.readRequest(invalidRequestPath), /INVALID_SKILL_GENERATION_REQUEST/)
  const mismatchedRequestPath = join(
    traceDir,
    'skill-learning',
    'requests',
    `request_${'c'.repeat(24)}.json`,
  )
  await writeFile(mismatchedRequestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8')
  await assert.rejects(store.readRequest(mismatchedRequestPath), /REQUEST_FILE_ID_MISMATCH/)
  const forgedRequestPath = join(
    traceDir,
    'skill-learning',
    'requests',
    `${forgedRequest.requestId}.json`,
  )
  await writeFile(forgedRequestPath, `${JSON.stringify(forgedRequest, null, 2)}\n`, 'utf8')
  await assert.rejects(store.readRequest(forgedRequestPath), /INVALID_REQUEST_ID/)

  assert.throws(
    () => assertSkillGenerationRequest({ ...request, runId: '/tmp/escape' }),
    /INVALID_SKILL_GENERATION_REQUEST/,
  )
  assert.throws(
    () => assertSkillGenerationRequest({ ...request, createdAt: '2026' }),
    /INVALID_SKILL_GENERATION_REQUEST/,
  )
  assert.throws(
    () => assertProposedSkill({ ...candidate.proposedSkill, triggers: {} }),
    /INVALID_PROPOSED_SKILL/,
  )

  const outsideCandidates = join(root, 'outside-candidates')
  const outsideReceipts = join(root, 'outside-receipts')
  const escapedStoreRoot = join(root, 'escaped-store')
  await mkdir(outsideCandidates)
  await mkdir(outsideReceipts)
  await mkdir(escapedStoreRoot)
  await writeFile(
    join(outsideCandidates, `${candidate.candidateId}.json`),
    `${JSON.stringify(candidate, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(outsideReceipts, `${receipt.requestId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  )
  await symlink(outsideCandidates, join(escapedStoreRoot, 'candidates'))
  await symlink(outsideReceipts, join(escapedStoreRoot, 'receipts'))
  const escapedStore = new FileSkillCandidateStore({ rootDir: escapedStoreRoot, now })
  await assert.rejects(
    escapedStore.readCandidate(candidate.candidateId),
    /CANDIDATE_STORE_PATH_OUTSIDE_ROOT/,
  )
  await assert.rejects(
    escapedStore.listCandidates(),
    /CANDIDATE_STORE_PATH_OUTSIDE_ROOT/,
  )
  await assert.rejects(
    escapedStore.readReceipt(receipt.requestId),
    /CANDIDATE_STORE_PATH_OUTSIDE_ROOT/,
  )

  const candidateFiles = await readdir(join(candidateRoot, 'candidates'))
  const receiptFiles = await readdir(join(candidateRoot, 'receipts'))
  assert(candidateFiles.every((name) => !name.includes('.tmp-')), 'candidate temp files should be removed')
  assert(receiptFiles.every((name) => !name.includes('.tmp-')), 'receipt temp files should be removed')
  assert.equal((await readFile(firstCandidate.path, 'utf8')).endsWith('\n'), true)

  console.log('skill-candidate-store-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

function generationRequestFixture() {
  const seed = {
    runId: 'run-skill-candidate-store',
    revision: 3,
    sessionId: 'session-skill-candidate-store',
    attempt: 2,
    outcomeArtifactId: 'outcome-skill-candidate-store',
    outcomeSha256: '1'.repeat(64),
  }
  return {
    schemaVersion: 'skill-generation-request/v1',
    requestId: generationRequestId(seed),
    createdAt: '2026-07-21T08:00:00.000Z',
    ...seed,
    traceSessionId: 'trace-session-skill-candidate-store',
    resultStatus: 'completed',
    requestedScope: 'project',
  }
}

function candidateFixture(request) {
  const finding = {
    schemaVersion: 'skill-candidate-finding/v1',
    severity: 'warning',
    code: 'FIXTURE_WARNING',
    path: '$.proposedSkill',
    message: 'Fixture warning.',
  }
  const evidence = {
    schemaVersion: 'projected-skill-evidence/v1',
    runId: request.runId,
    revision: request.revision,
    sessionId: request.sessionId,
    attempt: request.attempt,
    task: { taskType: 'explore' },
    successfulTools: [{ sequence: 1, toolName: 'browser_open', toolCategory: 'browser' }],
    actions: [{ actionKind: 'navigate', outcome: 'performed' }],
    resolvedSkills: [{
      id: 'builtin.explore',
      source: 'builtin',
      reason: 'taskType:explore',
      bodyHash: '2'.repeat(64),
    }],
    source: {
      outcomeArtifactId: request.outcomeArtifactId,
      outcomeSha256: request.outcomeSha256,
      traceSha256: '3'.repeat(64),
      resolvedSkillsSha256: '4'.repeat(64),
    },
  }
  const proposedSkill = {
    schemaVersion: 'proposed-skill/v1',
    id: 'learned.explore.fixture',
    name: 'Learned Explore Fixture',
    scope: 'project',
    priority: 500,
    triggers: { taskTypes: ['explore'] },
    provides: { promptSections: ['NEXT_ACTION_RULES'] },
    promptSections: [{
      id: 'NEXT_ACTION_RULES',
      summary: 'Call browser_open and verify that the step succeeded.',
    }],
    body: 'Generated from a deterministic fixture.',
  }
  const fingerprint = skillCandidateFingerprint(proposedSkill)
  return {
    schemaVersion: 'skill-candidate/v1',
    candidateId: candidateIdForFingerprint(fingerprint),
    createdAt: '2026-07-21T08:00:00.000Z',
    proposedSkill,
    provenance: {
      requestId: request.requestId,
      runId: request.runId,
      revision: request.revision,
      sessionId: request.sessionId,
      attempt: request.attempt,
      outcomeArtifactId: request.outcomeArtifactId,
      traceSha256: evidence.source.traceSha256,
      generatorId: 'fixture-generator',
      generatorVersion: '1',
    },
    evidenceSummary: evidence,
    fingerprint,
    validation: { blockers: [], warnings: [finding] },
  }
}

function receiptFixture(request, candidate) {
  return {
    schemaVersion: 'skill-generation-receipt/v1',
    requestId: request.requestId,
    processedAt: '2026-07-21T08:00:00.000Z',
    status: 'generated',
    candidateId: candidate.candidateId,
    findings: candidate.validation.warnings,
  }
}

async function jsonFiles(dir) {
  return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
}
