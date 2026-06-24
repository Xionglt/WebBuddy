import { browserOpen } from '../dist/browser/open.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { browserType } from '../dist/browser/type.js'
import { browserClick } from '../dist/browser/click.js'
import { browserWait } from '../dist/browser/wait.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'

const html = `<!doctype html><html><body>
  <h1>Application Form</h1>
  <label for="name">Full Name</label><input id="name" type="text" />
  <label for="email">Email</label><input id="email" type="email" />
  <select id="role"><option value="engineer">Engineer</option></select>
  <button type="submit">Submit Application</button>
</body></html>`

async function main() {
  const open = await browserOpen({ url: `data:text/html,${encodeURIComponent(html)}` })
  if (!open.ok) throw new Error(open.error.message)

  const snap = await browserSnapshot({})
  if (!snap.ok) throw new Error(snap.error.message)

  const nameRef = snap.data.elements.find((e) => e.name === 'Full Name')?.ref
  const emailRef = snap.data.elements.find((e) => e.name === 'Email')?.ref
  if (!nameRef || !emailRef) throw new Error('Failed to find form refs')

  const typedName = await browserType({ ref: nameRef, text: '张三' })
  const typedEmail = await browserType({ ref: emailRef, text: 'zhangsan@example.com' })
  const waited = await browserWait({ for: 'ms', ms: 200 })

  const submit = snap.data.elements.find((e) => e.risk === 'L3')
  if (!submit) throw new Error('Failed to classify submit button as L3')

  const blockedSubmit = await browserClick({ ref: submit.ref })
  if (blockedSubmit.ok || blockedSubmit.error.code !== 'CONFIRMATION_REQUIRED') {
    throw new Error('Expected high-risk click to require confirmation')
  }

  console.log('open:', open.observation)
  console.log('snapshot:', snap.observation, `refs=${snap.data.elements.length}`)
  console.log('type name:', typedName.observation)
  console.log('type email:', typedEmail.observation)
  console.log('wait:', waited.observation)
  console.log('submit risk:', submit?.ref, submit?.risk)
  console.log('submit guard:', blockedSubmit.observation)

  await sessionManager.closeAll()
  console.log('smoke test passed')
}

main().catch(async (error) => {
  console.error('smoke test failed:', error)
  await sessionManager.closeAll()
  process.exit(1)
})
