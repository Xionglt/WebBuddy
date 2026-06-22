/**
 * Resume parser unit test — exercises real pdfjs-dist extraction against a
 * generated sample PDF (no external files required).
 *
 *   npm run test:resume   (after build)
 */
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSampleResumePdf, readResume } from '../dist/sdk/resume.js'

const PDF = join(tmpdir(), 'mfa-resume-test.pdf')
writeSampleResumePdf(PDF)

const profile = await readResume(PDF)
assert(profile, 'readResume returned null')
assert.strictEqual(profile.source, 'pdf', `expected source=pdf, got ${profile.source}`)
assert.strictEqual(profile.name, 'Zhang San', `name: ${profile.name}`)
assert.strictEqual(profile.email, 'zhangsan@example.com', `email: ${profile.email}`)
assert.match(profile.phone ?? '', /13800001234/, `phone: ${profile.phone}`)

for (const skill of ['typescript', 'react', 'playwright', 'docker', 'kubernetes']) {
  assert(profile.skills.includes(skill), `missing skill ${skill}; have ${profile.skills.join(',')}`)
}
assert(profile.experience.length >= 1, 'expected at least one experience entry')
assert(profile.education.length >= 1, 'expected at least one education entry')

console.log('resume-test: PASS')
console.log(`  name : ${profile.name}`)
console.log(`  email: ${profile.email}`)
console.log(`  phone: ${profile.phone}`)
console.log(`  skills (${profile.skills.length}): ${profile.skills.join(', ')}`)
