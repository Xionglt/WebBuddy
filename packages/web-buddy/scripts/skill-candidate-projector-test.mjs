#!/usr/bin/env node
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { projectSkillEvidence } from '../dist/skills/candidates/index.js'
import { writeSkillCandidateFixture } from './skill-candidate-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-skill-candidate-projector-'))

try {
  const passing = await writeSkillCandidateFixture(root, { name: 'passing' })
  const projected = await projectSkillEvidence({
    traceDir: passing.traceDir,
    request: passing.request,
  })
  assert.equal(projected.eligible, true)
  assert.deepEqual(
    projected.evidence.successfulTools.map((step) => step.toolName),
    ['browser_open', 'browser_snapshot'],
  )
  assert.deepEqual(
    projected.evidence.successfulTools.map((step) => step.sequence),
    [1, 2],
  )
  assert.equal(projected.evidence.task.taskType, 'explore')
  assert.equal(projected.evidence.runId, passing.request.runId)
  assert.equal(projected.evidence.sessionId, passing.request.sessionId)
  assert.equal(projected.evidence.source.outcomeArtifactId, passing.request.outcomeArtifactId)
  assert.equal(projected.evidence.source.outcomeSha256, passing.request.outcomeSha256)
  assert.match(projected.evidence.source.traceSha256, /^[a-f0-9]{64}$/)
  assert.match(projected.evidence.source.resolvedSkillsSha256, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(projected)
  for (const marker of [
    'RAW_INPUT_MUST_NOT_PROJECT',
    'fixture/private.txt',
    'PRIVATE_PAGE_TEXT_MUST_NOT_PROJECT',
    'PRIVATE_SUMMARY_MUST_NOT_PROJECT',
    'RAW_OUTPUT_MUST_NOT_PROJECT',
    'RAW_METADATA_MUST_NOT_PROJECT',
    'RAW_OBSERVATION_MUST_NOT_PROJECT',
    'PRIVATE_SKILL_PROMPT_MUST_NOT_PROJECT',
    'PRIVATE_OUTCOME_SUMMARY_MUST_NOT_PROJECT',
  ]) {
    assert.equal(serialized.includes(marker), false, `projection leaked ${marker}`)
  }

  const durable = await writeSkillCandidateFixture(root, {
    name: 'durable',
    durableSession: true,
    resultSessionId: 'durable-session',
    runtimeSessionId: 'durable-session',
    attempt: 3,
  })
  const durableProjected = await projectSkillEvidence({
    traceDir: durable.traceDir,
    request: durable.request,
  })
  assert.equal(durableProjected.eligible, true)
  assert.equal(durableProjected.evidence.sessionId, 'durable-session')
  assert.equal(durableProjected.evidence.attempt, 3)

  const urlReason = await writeSkillCandidateFixture(root, {
    name: 'url-reason',
    resolvedReason: 'urlPattern:https://example.test/private/path?token=URL_REASON_MUST_NOT_PROJECT',
  })
  const urlReasonProjected = await projectSkillEvidence({
    traceDir: urlReason.traceDir,
    request: urlReason.request,
  })
  assert.equal(urlReasonProjected.eligible, true)
  assert.equal(urlReasonProjected.evidence.resolvedSkills[0].reason, 'urlPattern:matched')
  assert.equal(JSON.stringify(urlReasonProjected).includes('URL_REASON_MUST_NOT_PROJECT'), false)

  await assertFinding(root, 'blocked', { outcomeStatus: 'blocked' }, 'OUTCOME_NOT_COMPLETED')
  await assertFinding(root, 'missing-done', { missingDone: true }, 'TRACE_INCOMPLETE')
  const missingDone = await writeSkillCandidateFixture(root, {
    name: 'missing-done-message',
    missingDone: true,
  })
  const missingDoneResult = await projectSkillEvidence({
    traceDir: missingDone.traceDir,
    request: missingDone.request,
  })
  assert.equal(JSON.stringify(missingDoneResult).includes(root), false)
  await assertFinding(
    root,
    'resolved-session-mismatch',
    { resolvedSessionId: 'other-runtime-session' },
    'RESOLVED_SKILLS_IDENTITY_MISMATCH',
  )
  await assertFinding(root, 'trace-redacted', { traceRedacted: true }, 'SOURCE_REDACTED')
  await assertFinding(
    root,
    'source-artifact-redacted',
    { sourceArtifactRedacted: true },
    'SOURCE_REDACTED',
  )
  await assertFinding(
    root,
    'duplicate-outcome',
    { duplicateOutcome: true },
    'OUTCOME_ARTIFACT_AMBIGUOUS',
  )
  await assertFinding(
    root,
    'oversized-spans-file',
    { spansPaddingBytes: 8 * 1024 * 1024 },
    'EVIDENCE_TOO_LARGE',
  )
  await assertFinding(
    root,
    'oversized-outcome-file',
    { outcomePaddingBytes: 8 * 1024 * 1024 },
    'EVIDENCE_TOO_LARGE',
  )
  await assertFinding(root, 'too-many-spans', { spanCount: 4097 }, 'EVIDENCE_TOO_LARGE')
  await assertFinding(root, 'too-many-events', { eventCount: 4097 }, 'EVIDENCE_TOO_LARGE')
  await assertFinding(root, 'too-many-tool-steps', { spanCount: 66 }, 'EVIDENCE_TOO_LARGE')
  await assertFinding(root, 'too-many-actions', { actionCount: 65 }, 'EVIDENCE_TOO_LARGE')
  await assertFinding(
    root,
    'too-many-resolved-skills',
    { resolvedSkillCount: 65 },
    'EVIDENCE_TOO_LARGE',
  )

  const symlinkFixture = await writeSkillCandidateFixture(root, { name: 'symlink-outcome' })
  const outsideDir = join(root, 'outside-outcome')
  await mkdir(outsideDir)
  const outsideOutcome = join(outsideDir, `${symlinkFixture.request.outcomeArtifactId}.json`)
  await copyFile(symlinkFixture.outcomePath, outsideOutcome)
  await rm(symlinkFixture.outcomePath)
  await symlink(outsideOutcome, symlinkFixture.outcomePath)
  const symlinkResult = await projectSkillEvidence({
    traceDir: symlinkFixture.traceDir,
    request: symlinkFixture.request,
  })
  assert.equal(symlinkResult.eligible, false)
  assert(symlinkResult.findings.some((finding) => finding.code === 'UNSAFE_OUTCOME_ARTIFACT_PATH'))

  console.log('skill-candidate-projector-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function assertFinding(root, name, options, expectedCode) {
  const fixture = await writeSkillCandidateFixture(root, { name, ...options })
  const result = await projectSkillEvidence({
    traceDir: fixture.traceDir,
    request: fixture.request,
  })
  assert.equal(result.eligible, false, `${name} should be ineligible`)
  assert(
    result.findings.some((finding) => finding.code === expectedCode),
    `${name} should report ${expectedCode}: ${JSON.stringify(result.findings)}`,
  )
}
