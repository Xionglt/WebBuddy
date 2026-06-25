import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Structured resume profile — the canonical representation the matcher and the
 * application form-filler both consume. Everything is optional because PDF
 * extraction is best-effort and the user can always edit the JSON.
 */
export interface ResumeExperience {
  company?: string
  title?: string
  period?: string
  summary?: string
}

export interface ResumeEducation {
  school?: string
  degree?: string
  major?: string
  period?: string
}

export interface ResumeProfile {
  name?: string
  email?: string
  phone?: string
  location?: string
  summary?: string
  /** Normalized lower-case skill tokens, e.g. ["typescript", "react", "k8s"]. */
  skills: string[]
  experience: ResumeExperience[]
  education: ResumeEducation[]
  /** Free-form keywords derived from the raw text (for matching fallback). */
  keywords: string[]
  /** Where the profile came from. */
  source: 'pdf' | 'json' | 'txt'
}

// ---------------------------------------------------------------------------
// PDF text extraction (pdfjs-dist)
// ---------------------------------------------------------------------------

interface PdfTextLib {
  getDocument: (params: { data: Uint8Array; isEvalSupported?: boolean }) => {
    promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage> }>
  }
  GlobalWorkerOptions: { workerSrc: string }
}

interface PdfPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>
}

/**
 * Extract plain text from a PDF using pdfjs-dist.
 *
 * pdfjs is loaded dynamically so it stays an optional runtime dependency and
 * does not get pulled into the MCP server bundle path. The worker runs on the
 * main thread via the fake-worker fallback (workerSrc resolves to the shipped
 * worker module, which Node can dynamic-import).
 */
export async function extractTextFromPdf(filePath: string): Promise<string> {
  const data = new Uint8Array(readFileSync(filePath))
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as PdfTextLib
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
    )
  } catch {
    // Falls back to main-thread fake worker if resolution fails.
  }

  let standardFontDataUrl: string | undefined
  try {
    standardFontDataUrl = require.resolve('pdfjs-dist/standard_fonts/')
  } catch {
    // Optional: silences a harmless "standardFontDataUrl" warning.
  }

  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise
  const lines: string[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let buffer = ''
    for (const item of content.items) {
      const str = item.str ?? ''
      buffer += str
      if (item.hasEOL) {
        lines.push(buffer)
        buffer = ''
      } else if (str) {
        buffer += ' '
      }
    }
    if (buffer.trim()) lines.push(buffer)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Heuristic field extraction
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/

const SKILL_DICTIONARY = [
  'typescript', 'javascript', 'python', 'java', 'go', 'golang', 'rust', 'c++', 'c#',
  'react', 'vue', 'angular', 'next.js', 'node', 'nodejs', 'deno',
  'playwright', 'selenium', 'puppeteer',
  'docker', 'kubernetes', 'k8s', 'terraform', 'helm',
  'aws', 'gcp', 'azure', 'aliyun',
  'mysql', 'postgres', 'redis', 'kafka', 'mongodb', 'elasticsearch',
  'graphql', 'grpc', 'rest', 'protobuf',
  'machine learning', 'deep learning', 'pytorch', 'tensorflow', 'nlp', 'llm',
  'spark', 'flink', 'hadoop', 'hive',
  'linux', 'git', 'ci/cd', 'jenkins', 'microservices', 'ddd', 'ddd',
  '产品经理', '后端', '前端', '全栈', '算法', '数据', '测试', '运维', 'devops',
  'node.js', 'express', 'nestjs', 'spring', 'django', 'fastapi', 'flask',
]

function findFirst(text: string, re: RegExp): string | undefined {
  const m = text.match(re)
  return m ? m[0].trim() : undefined
}

function extractName(lines: string[]): string | undefined {
  // First non-empty line that is NOT an email/phone/header and is short enough
  // to plausibly be a name. Prefers lines containing CJK or capitalized words.
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (EMAIL_RE.test(line) || PHONE_RE.test(line)) continue
    if (/^(email|phone|tel|手机|邮箱|电话|地址|summary|技能|skills|experience|教育)/i.test(line)) continue
    if (line.length > 30) continue
    const hasCjk = /[一-鿿]{2,}/.test(line)
    const hasCapitalized = /[A-Z][a-z]+\s[A-Z][a-z]+/.test(line)
    if (hasCjk || hasCapitalized) return line
  }
  return undefined
}

function extractSkills(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `
  const found = new Set<string>()
  for (const skill of SKILL_DICTIONARY) {
    const needle = skill.toLowerCase()
    // Substring match (not regex) — skills like "c++" and "c#" are literal.
    if (lower.includes(needle)) found.add(needle)
  }
  return [...found].sort()
}

function extractExperience(lines: string[]): ResumeExperience[] {
  const out: ResumeExperience[] = []
  // Heuristic: a line with a date range (2019-2021 / 2021.01- ...) followed by
  // a company-ish line.
  const dateRe = /(19|20)\d{2}[\s./-]*(0?[1-9]|1[012])?[\s./-]*[-–~至到]{1,3}[\s./-]*(19|20)\d{2}|至今|present|now/i
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!dateRe.test(line)) continue
    const company = lines[i - 1]?.trim() || undefined
    const title = lines[i + 1]?.trim() || undefined
    out.push({ company, period: line, title, summary: undefined })
    if (out.length >= 8) break
  }
  return out
}

function extractEducation(lines: string[]): ResumeEducation[] {
  const out: ResumeEducation[] = []
  const eduKeywords = /(大学|university|学院|college|本科|硕士|博士|bachelor|master|ph\.?d)/i
  for (const raw of lines) {
    const line = raw.trim()
    if (!eduKeywords.test(line)) continue
    const degree = line.match(/(本科|硕士|博士|bachelor|master|ph\.?d)/i)?.[0]
    out.push({ school: line, degree })
    if (out.length >= 4) break
  }
  return out
}

/** Parse a plain-text blob (already extracted) into a structured profile. */
export function parseResumeText(text: string, source: ResumeProfile['source']): ResumeProfile {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const flat = lines.join('\n')

  const skills = extractSkills(flat)
  const keywords = [
    ...skills,
    ...lines
      .filter((l) => l.length <= 18 && /^[一-鿿A-Za-z .+#/-]+$/.test(l))
      .map((l) => l.toLowerCase()),
  ]
  const keywordSet = [...new Set(keywords)]

  return {
    name: extractName(lines),
    email: findFirst(flat, EMAIL_RE),
    phone: findFirst(flat, PHONE_RE),
    location: undefined,
    summary: lines.slice(0, 1).join(' '),
    skills,
    experience: extractExperience(lines),
    education: extractEducation(lines),
    keywords: keywordSet,
    source,
  }
}

/**
 * Read a resume from disk. Supports:
 *   - .pdf   (primary, parsed with pdfjs-dist)
 *   - .json  (already-structured ResumeProfile, for deterministic demos)
 *   - .txt   (plain text, heuristically parsed)
 *
 * If the path does not exist, returns null so the caller can decide whether to
 * fall back to a generated sample resume.
 */
export async function readResume(filePath: string): Promise<ResumeProfile | null> {
  if (!existsSync(filePath)) return null
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ResumeProfile>
    return { skills: [], experience: [], education: [], keywords: [], source: 'json', ...parsed }
  }
  if (lower.endsWith('.txt')) {
    return parseResumeText(readFileSync(filePath, 'utf8'), 'txt')
  }
  if (lower.endsWith('.pdf')) {
    const text = await extractTextFromPdf(filePath)
    return parseResumeText(text, 'pdf')
  }
  return null
}

// ---------------------------------------------------------------------------
// Sample resume PDF generator
// ---------------------------------------------------------------------------

/**
 * Write a minimal but VALID one-page PDF with extractable text. Used by the
 * demo (so it runs without a real resume) and by the resume unit test (so it
 * verifies genuine pdfjs-dist extraction end-to-end).
 *
 * The layout is intentionally simple: each `line` becomes a `(...) Tj` on its
 * own text line with correct xref offsets computed from the assembled bytes.
 */
export function writeSampleResumePdf(
  filePath: string,
  lines: string[] = SAMPLE_RESUME_LINES,
): void {
  mkdirSync(dirname(filePath), { recursive: true })

  const header = '%PDF-1.4\n'
  const objects: string[] = []

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  )
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  // Build the content stream: start text, 12pt, position first line, then
  // step down 18pt per line.
  const streamParts: string[] = ['BT', '/F1 12 Tf', '72 720 Td', '18 TL']
  for (let i = 0; i < lines.length; i += 1) {
    const escaped = lines[i].replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    streamParts.push(`(${escaped}) Tj`)
    if (i < lines.length - 1) streamParts.push('T*')
  }
  streamParts.push('ET')
  const stream = streamParts.join('\n')
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)

  // Assemble body with byte-accurate xref offsets.
  let body = header
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefStart = Buffer.byteLength(body)
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`

  writeFileSync(filePath, Buffer.from(body + xref + trailer, 'latin1'))
}

export const SAMPLE_RESUME_LINES = [
  'Zhang San',
  'Email: zhangsan@example.com  Phone: 13800001234',
  'Summary: Senior frontend engineer with 6 years building large-scale web apps.',
  '',
  'Skills: TypeScript React Vue Next.js Node.js Playwright Docker Kubernetes AWS',
  '',
  'Experience',
  'Ant Group',
  '2021.05-Present',
  'Senior Frontend Engineer',
  'Built internal tooling platform with React and TypeScript.',
  '',
  'ByteDance',
  '2019.07-2021.04',
  'Frontend Engineer',
  'Developed component library and automated E2E tests with Playwright.',
  '',
  'Education',
  'Zhejiang University, Bachelor, Computer Science, 2015-2019',
]
