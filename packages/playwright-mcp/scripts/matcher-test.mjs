/**
 * Matcher unit test — verifies deterministic heuristic ranking without a
 * browser or an LLM.
 *
 *   npm run test:matcher   (after build)
 */
import assert from 'node:assert'
import { matchJobs } from '../dist/sdk/matcher.js'

const profile = {
  source: 'json',
  skills: ['typescript', 'react', 'node', 'docker', 'playwright'],
  experience: [],
  education: [],
  keywords: ['typescript', 'react', 'frontend'],
}

const jobs = [
  {
    id: 'perfect',
    title: '高级前端工程师 Senior Frontend Engineer',
    category: '技术-前端',
    searchText: 'react typescript node 前端 工程师',
    tags: ['react', 'typescript', 'node', 'frontend', '工程师'],
  },
  {
    id: 'partial',
    title: '后端工程师 Backend Engineer (Go)',
    category: '技术-后端',
    searchText: 'go kubernetes microservices',
    tags: ['go', 'kubernetes', 'microservices'],
  },
  {
    id: 'none',
    title: '产品经理 Product Manager',
    category: '产品',
    searchText: '产品 需求 设计',
    tags: ['产品', '需求', '设计'],
  },
]

const matches = matchJobs(profile, jobs)

assert.strictEqual(matches[0].job.id, 'perfect', `best should be 'perfect', got ${matches[0].job.id}`)
assert.strictEqual(matches[matches.length - 1].job.id, 'none', `worst should be 'none'`)
const best = matches[0]
assert(best.score > 0.5, `best score should be high, got ${best.score}`)
assert(best.matchedSkills.includes('react') && best.matchedSkills.includes('typescript'), 'react+typescript must be matched')
// Matched skills must never also appear in missing skills (invariant).
for (const s of best.matchedSkills) {
  assert(!best.missingSkills.includes(s), `skill ${s} is both matched and missing`)
}
// The zero-overlap job must score lowest and have no matched skills.
const worst = matches[matches.length - 1]
assert.strictEqual(worst.matchedSkills.length, 0, 'zero-overlap job should match nothing')

console.log('matcher-test: PASS')
for (const m of matches) {
  console.log(`  ${m.job.id.padEnd(8)} score=${m.score.toFixed(2)}  matched=[${m.matchedSkills.join(',')}]  missing=[${m.missingSkills.join(',')}]`)
}
