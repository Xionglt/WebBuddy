/**
 * Resume ingestion v2 unit test. Uses synthetic local fixtures only.
 *
 *   npm run build
 *   npm run test:resume-ingest
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readResume,
  readResumeV2,
  resumeV2ToLegacyProfile,
  writeSampleResumePdf,
} from '../dist/sdk/resume.js'

const fixturesUrl = new URL('./fixtures/resumes/', import.meta.url)
const JSON_RESUME = fileURLToPath(new URL('fixture-resume.json', fixturesUrl))
const TXT_RESUME = fileURLToPath(new URL('fixture-resume.txt', fixturesUrl))
const MIXED_ZH_EN_RESUME = fileURLToPath(new URL('mixed-zh-en-resume.txt', fixturesUrl))
const LOW_QUALITY_RESUME = fileURLToPath(new URL('low-quality-extracted-resume.txt', fixturesUrl))
const PDF_LINES = fileURLToPath(new URL('generated-pdf-resume-lines.txt', fixturesUrl))

function assertConfidence(field, label, { expectEvidence = true } = {}) {
  assert(field, `${label} should be present`)
  assert.equal(typeof field.confidence, 'number', `${label} confidence should be numeric`)
  assert(field.confidence >= 0 && field.confidence <= 1, `${label} confidence should be within [0, 1]`)
  if (expectEvidence) {
    assert.equal(typeof field.evidence, 'string', `${label} evidence should be present`)
    assert(field.evidence.length > 0, `${label} evidence should not be empty`)
  }
}

function assertResumeV2Shape(profile, label) {
  assert(profile, `${label} should parse`)
  assert.equal(profile.schemaVersion, 'resume-profile/v2', `${label} schema version`)
  for (const key of ['targetRoles', 'skills', 'projects', 'experience', 'education', 'keywords']) {
    assertConfidence(profile[key], `${label}.${key}`)
    assert(Array.isArray(profile[key].value), `${label}.${key}.value should be an array`)
  }
  assert(Array.isArray(profile.source.extractionWarnings), `${label} warnings should be an array`)
  assert(['heuristic', 'llm', 'llm_with_heuristic_repair', 'json'].includes(profile.source.parser))
}

const noKeyLlm = {
  hasKey: false,
  async generateJson() {
    throw new Error('should not call generateJson without a key')
  },
}

const jsonLegacy = await readResume(JSON_RESUME)
assert(jsonLegacy, 'JSON legacy resume should parse')
assert.equal(jsonLegacy.source, 'json')
assert.equal(jsonLegacy.name, 'Jordan Fixture')
assert(jsonLegacy.skills.includes('typescript'), 'JSON legacy skills should be preserved')

const jsonV2 = await readResumeV2(JSON_RESUME)
assertResumeV2Shape(jsonV2, 'jsonV2')
assert.equal(jsonV2.source.type, 'json')
assert.equal(jsonV2.source.parser, 'json')
assert.equal(jsonV2.name?.value, 'Jordan Fixture')
assertConfidence(jsonV2.name, 'jsonV2.name')
assertConfidence(jsonV2.email, 'jsonV2.email')
assert(jsonV2.skills.value.includes('docker'), 'JSON v2 skills should be preserved')
assert.equal(resumeV2ToLegacyProfile(jsonV2).source, 'json')

const txtLegacy = await readResume(TXT_RESUME)
assert(txtLegacy, 'TXT legacy resume should parse')
assert.equal(txtLegacy.source, 'txt')
assert.equal(txtLegacy.email, 'alex.fixture@example.test')

const txtFallback = await readResumeV2(TXT_RESUME, { llm: noKeyLlm })
assertResumeV2Shape(txtFallback, 'txtFallback')
assert.equal(txtFallback.source.type, 'txt')
assert.equal(txtFallback.source.parser, 'heuristic')
assert(txtFallback.source.extractionWarnings.some((warning) => warning.includes('No model key')))
assert.equal(txtFallback.email?.value, txtLegacy.email)
assert(txtFallback.skills.value.includes('playwright'), 'TXT fallback should preserve heuristic skills')

const pdfPath = join(tmpdir(), 'mfa-resume-ingest-generated-fixture.pdf')
const pdfLines = readFileSync(PDF_LINES, 'utf8').split(/\r?\n/)
writeSampleResumePdf(pdfPath, pdfLines)
const pdfFallback = await readResumeV2(pdfPath, { llm: noKeyLlm })
assertResumeV2Shape(pdfFallback, 'pdfFallback')
assert.equal(pdfFallback.source.type, 'pdf-text')
assert.equal(pdfFallback.source.parser, 'heuristic')
assert.equal(resumeV2ToLegacyProfile(pdfFallback).source, 'pdf')
assert.equal(pdfFallback.email?.value, 'priya.pdf.fixture@example.test')
assert(pdfFallback.skills.value.includes('kubernetes'), 'PDF fallback should preserve sample skills')

const mixedProfile = await readResumeV2(MIXED_ZH_EN_RESUME, { llm: noKeyLlm })
assertResumeV2Shape(mixedProfile, 'mixedProfile')
assert.equal(mixedProfile.source.type, 'txt')
assert.equal(mixedProfile.name?.value, '王小明 | Wang Xiaoming')
assert.equal(mixedProfile.email?.value, 'wang.fixture@example.test')
assert(mixedProfile.phone?.value.includes('+86'), `mixed phone: ${mixedProfile.phone?.value}`)
for (const skill of ['typescript', 'react', 'python', 'llm', '后端', '全栈']) {
  assert(mixedProfile.skills.value.includes(skill), `mixed fixture missing skill ${skill}`)
}
assert(mixedProfile.education.value.length >= 1, 'mixed fixture should include education evidence')

const llmCalls = []
const fakeStructuredLlm = {
  hasKey: true,
  async generateJson(_system, _user, options) {
    llmCalls.push(options)
    return {
      schemaVersion: 'resume-profile/v2',
      name: { value: 'Alex Fixture', confidence: 0.92, evidence: 'header' },
      email: { value: 'wrong@example.test', confidence: 0.35, evidence: 'line with alex.fixture@example.test' },
      phone: { value: '0000000000', confidence: 0.35, evidence: 'contact line' },
      location: { value: 'Seattle, WA', confidence: 0.86, evidence: 'location line' },
      summary: { value: 'Senior frontend engineer', confidence: 0.8, evidence: 'summary section' },
      targetRoles: { value: ['Frontend Engineer'], confidence: 0.84, evidence: 'title and summary' },
      skills: { value: ['TypeScript', 'React', 'Playwright'], confidence: 0.9, evidence: 'skills section' },
      projects: { value: [], confidence: 0.2, evidence: 'no dedicated project section' },
      experience: {
        value: [{
          company: 'Fixture Labs',
          title: 'Senior Frontend Engineer',
          period: '2020.01-Present',
          summary: 'Built internal tooling.',
        }],
        confidence: 0.86,
        evidence: 'experience section',
      },
      education: {
        value: [{
          school: 'Example University',
          degree: 'Bachelor',
          major: 'Computer Science',
          period: '2014-2018',
        }],
        confidence: 0.82,
        evidence: 'education section',
      },
      keywords: { value: ['frontend', 'typescript', 'browser automation'], confidence: 0.8, evidence: 'summary and skills' },
      seniority: { value: 'senior', confidence: 0.8, evidence: 'senior title' },
    }
  },
}

const llmProfile = await readResumeV2(TXT_RESUME, { llm: fakeStructuredLlm })
assertResumeV2Shape(llmProfile, 'llmProfile')
assert.equal(llmProfile.source.parser, 'llm_with_heuristic_repair')
assert.equal(llmProfile.email?.value, 'alex.fixture@example.test')
assert.equal(llmProfile.phone?.value, '+1 555 010 2233')
assert(llmProfile.source.extractionWarnings.some((warning) => warning.includes('Email field repaired')))
assert(llmProfile.source.extractionWarnings.some((warning) => warning.includes('Phone field repaired')))
assert.equal(llmCalls.length, 1, 'LLM should be called once')
assert.equal(llmCalls[0]?.redactTrace, true, 'resume LLM calls must request trace redaction')
assert(!llmProfile.email?.evidence?.includes('alex.fixture@example.test'), 'email evidence should be redacted')

const malformedLlm = {
  hasKey: true,
  async generateJson() {
    return { name: 'not a field object' }
  },
}
const malformedFallback = await readResumeV2(TXT_RESUME, { llm: malformedLlm })
assertResumeV2Shape(malformedFallback, 'malformedFallback')
assert.equal(malformedFallback.source.parser, 'heuristic')
assert(malformedFallback.source.extractionWarnings.some((warning) => warning.includes('LLM resume JSON parse failed')))
assert.equal(malformedFallback.email?.value, txtLegacy.email)

const throwingLlm = {
  hasKey: true,
  async generateJson() {
    throw new Error('synthetic parser outage')
  },
}
const lowQualityFallback = await readResumeV2(LOW_QUALITY_RESUME, { llm: throwingLlm })
assertResumeV2Shape(lowQualityFallback, 'lowQualityFallback')
assert.equal(lowQualityFallback.source.type, 'txt')
assert.equal(lowQualityFallback.source.parser, 'heuristic')
assert(lowQualityFallback.source.extractionWarnings.some((warning) => warning.includes('LLM resume JSON parse failed')))
assert.equal(lowQualityFallback.email?.value, 'low.quality.fixture@example.test')
assert.equal(lowQualityFallback.skills.value.length, 0, 'low-quality fixture should not invent skills')
assert(lowQualityFallback.skills.confidence < 0.3, `low-quality skills confidence: ${lowQualityFallback.skills.confidence}`)
assert(
  lowQualityFallback.targetRoles.confidence < 0.3,
  `low-quality target role confidence: ${lowQualityFallback.targetRoles.confidence}`,
)
assert(lowQualityFallback.projects.confidence < 0.2, `low-quality projects confidence: ${lowQualityFallback.projects.confidence}`)

console.log('resume-ingest-test: PASS')
