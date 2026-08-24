#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createWebControlServer } from '../dist/web/server.js'
import { ActionLedger } from '../dist/task/action-ledger.js'
import {
  externalActionEffectDigest,
  reconcileExternalAction,
} from '../dist/task/action-reconciliation.js'
import { materializeExternalActionReceipt } from '../dist/task/action-reconciliation-artifact.js'
import { evaluateCompletionContract } from '../dist/task/completion-contract.js'
import { FileToolResultStore } from '../dist/tools/tool-result-store.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-invoice-poc-'))
const control = createWebControlServer({
  controlStoreDir: join(root, 'control'),
  memoryDir: join(root, 'memory'),
  disableExecution: true,
})

await new Promise((resolve, reject) => {
  control.server.once('error', reject)
  control.server.listen(0, '127.0.0.1', resolve)
})
const address = control.server.address()
assert(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}`
const invoiceIds = ['INV-CN-260601', 'INV-CN-260602', 'INV-CN-260603', 'INV-CN-260604']
const invoiceAmounts = [48_600, 36_000, 62_800, 39_000]
const invoiceServicePeriods = ['not_applicable', 'not_applicable', '2026年第二季度', 'not_applicable']
const businessKeys = invoiceIds.map((invoiceId) => `portal:huadong-fssc:invoice:${invoiceId}`)

const browser = await chromium.launch({ headless: true })
try {
  for (const path of ['/poc/invoice-portal', '/poc/invoice-portal/']) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') || '', /^text\/html/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(await response.text(), /接手 · 客户门户代办箱/)
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`${baseUrl}/poc/invoice-portal`, { waitUntil: 'domcontentloaded' })

  await assertText(page, 'h1', '6 项回款资料，4 项可以直接提交')
  await assertText(page, '.browser-name', '华东智造 · 财务共享门户')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 0)
    assert.equal(state.receiptCount, 0)
    assert.equal(state.invoiceStatuses['INV-CN-260598'], 'duplicate')
    assert.equal(state.invoiceStatuses['INV-CN-260605'], 'exception')
  })

  if (process.env.POC_INITIAL_SCREENSHOT) {
    await page.screenshot({ path: process.env.POC_INITIAL_SCREENSHOT, fullPage: true })
  }
  if (process.env.POC_MOBILE_SCREENSHOT) {
    const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await mobilePage.goto(`${baseUrl}/poc/invoice-portal`, { waitUntil: 'domcontentloaded' })
    await mobilePage.screenshot({ path: process.env.POC_MOBILE_SCREENSHOT, fullPage: true })
    await mobilePage.close()
  }

  await page.getByRole('button', { name: '开始准备这 4 项' }).click()
  await page.waitForFunction(() => window.__INVOICE_POC_STATE__?.awaitingInput === true)
  await assertText(page, '#attentionCard', '缺少服务期间')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 0)
    assert.equal(state.awaitingInput, true)
  })

  await page.getByLabel('选择服务期间').selectOption('2026年第二季度')
  await page.getByRole('button', { name: '补充并继续' }).click()
  await page.locator('#approvalModal').waitFor({ state: 'visible', timeout: 15_000 })
  await assertText(page, '#approvalModal', '任何字段变化都会重新请求批准')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 0)
    assert.equal(state.approved, false)
    assert.equal(Object.values(state.invoiceStatuses).filter((status) => status === 'ready').length, 4)
  })

  // One bounded batch approval fans out into four independently journaled
  // external actions. Simulate a crash after the portal creates all receipts
  // but before the local runtime persists any of them.
  const beforeCrash = new ActionLedger(() => new Date('2026-08-12T00:00:00.000Z'))
  for (const [index, businessKey] of businessKeys.entries()) {
    const actionId = `poc-submit:${invoiceIds[index]}`
    beforeCrash.propose({
      actionId,
      actionKind: 'submit',
      toolName: 'invoice_portal_submit_one',
      externalBinding: {
        schemaVersion: 'external-action-binding/v2',
        businessKey,
        probeId: 'invoice-portal-poc-receipt-query/v1',
        effectDigest: externalActionEffectDigest({
          actionId,
          actionKind: 'submit',
          toolName: 'invoice_portal_submit_one',
          args: { invoiceId: invoiceIds[index], amount: invoiceAmounts[index] },
          destinationOrigin: new URL(baseUrl).origin,
          effectPayload: {
            invoiceId: invoiceIds[index],
            amount: invoiceAmounts[index],
            servicePeriod: invoiceServicePeriods[index],
            attachmentVersion: 'erp-export-v1',
          },
        }),
      },
    })
    beforeCrash.authorize(
      actionId,
      'The user approved this invoice inside the exact four-item batch.',
      {
        schemaVersion: 'action-decision-ref/v1',
        source: 'human_gate',
        decisionRef: 'poc-batch-approval:2026-q2:four-invoices',
      },
    )
    beforeCrash.begin(actionId, 'Durable execution boundary before the portal effect.')
  }

  await page.getByRole('button', { name: '批准并提交 4 张' }).click()
  await page.waitForFunction(() => window.__INVOICE_POC_STATE__?.committedSubmissions === 4)
  await page.locator('#receiptModal').waitFor({ state: 'visible' })
  await assertText(page, '#receiptModal', '4 张发票已被门户接受')
  await assertState(page, (state) => {
    assert.equal(state.receiptCount, 4)
    assert.equal(state.committedSubmissions, 4)
    assert.equal(state.receipts.length, 4)
    assert.equal(state.invoiceStatuses['INV-CN-260598'], 'duplicate')
    assert.equal(state.invoiceStatuses['INV-CN-260605'], 'exception')
  })

  const restoredLedger = ActionLedger.restore(
    beforeCrash.snapshot(),
    () => new Date('2026-08-12T00:01:00.000Z'),
  )
  assert.deepEqual(
    [...new Set(
      restoredLedger.snapshot()
        .filter((entry) => entry.status === 'executing')
        .map((entry) => entry.actionDecision?.decisionRef),
    )],
    ['poc-batch-approval:2026-q2:four-invoices'],
    'the four independently journaled actions must retain the same bounded batch approval reference',
  )
  let portalProbeCalls = 0
  const portalProbe = {
    schemaVersion: 'external-action-probe/v1',
    id: 'invoice-portal-poc-receipt-query/v1',
    authority: 'read_only',
    async reconcile(request) {
      portalProbeCalls += 1
      const invoiceId = request.businessKey.split(':').at(-1)
      const receipt = await page.evaluate((expectedInvoiceId) => (
        window.__INVOICE_POC_STATE__?.receipts?.find((item) => item.invoiceId === expectedInvoiceId)
      ), invoiceId)
      const observedEffectDigest = receipt
        ? externalActionEffectDigest({
            actionId: request.action.actionId,
            actionKind: request.action.actionKind,
            toolName: 'portal_readback',
            args: {},
            destinationOrigin: new URL(baseUrl).origin,
            effectPayload: {
              invoiceId: receipt.invoiceId,
              amount: receipt.amount,
              servicePeriod: receipt.servicePeriod,
              attachmentVersion: receipt.attachmentVersion,
            },
          })
        : undefined
      return {
        schemaVersion: 'external-action-reconciliation/v1',
        actionId: request.action.actionId,
        businessKey: request.businessKey,
        state: receipt ? 'committed' : 'ambiguous',
        observedAt: new Date().toISOString(),
        verifier: this.id,
        independentlyObserved: Boolean(receipt),
        evidenceIds: receipt
          ? [`poc-receipt:${receipt.confirmation}`, `poc-field-readback:${observedEffectDigest}`]
          : [],
        ...(receipt ? { externalReference: receipt.confirmation } : {}),
        ...(observedEffectDigest ? { observedEffectDigest } : {}),
        summary: receipt
          ? 'The controlled portal receipt registry contains this invoice and confirmation number.'
          : 'The controlled portal did not expose a conclusive receipt.',
      }
    },
  }
  const receiptStore = new FileToolResultStore({ rootDir: join(root, 'recovered-receipts') })
  const receiptArtifacts = []
  for (const invoiceId of invoiceIds) {
    const result = await reconcileExternalAction({
      ledger: restoredLedger,
      actionId: `poc-submit:${invoiceId}`,
      probe: portalProbe,
    })
    assert.equal(result.ledgerEntry.status, 'committed')
    assert.match(result.verdict.externalReference, /^CSP-88412[0-3]$/)
    const receipt = await materializeExternalActionReceipt({
      store: receiptStore,
      runId: 'invoice-portal-poc-recovery',
      revision: 0,
      sessionId: 'invoice-portal-poc-recovery-session',
      action: result.ledgerEntry,
      verdict: result.verdict,
    })
    await receiptStore.read(receipt.storageRef)
    receiptArtifacts.push(receipt.artifact)
  }
  const recoveryContract = {
    schemaVersion: 'web-task-contract/v1',
    contractId: 'invoice-portal-poc-recovery',
    revision: 0,
    criteria: [
      {
        id: 'all-invoices-committed',
        kind: 'action_boundary',
        description: 'Every invoice in the approved batch has an independent portal receipt.',
        actionKinds: ['submit'],
        outcome: 'performed',
        businessKeys,
      },
      {
        id: 'all-receipt-artifacts-present',
        kind: 'artifact_present',
        description: 'Every committed invoice has an immutable receipt artifact.',
        artifactKinds: ['external_action_receipt'],
        schemaVersions: ['external-action-receipt/v1'],
        minCount: 4,
        businessKeys,
      },
    ],
  }
  const recoveredCompletion = evaluateCompletionContract({
    contract: recoveryContract,
    runId: 'invoice-portal-poc-recovery',
    revision: 0,
    evidence: [],
    artifacts: receiptArtifacts,
    actions: restoredLedger.outcomes(['submit']),
  })
  assert.equal(recoveredCompletion.completed, true)
  assert.equal(recoveredCompletion.artifactIds.length, 4)
  const unrelatedReceiptCompletion = evaluateCompletionContract({
    contract: recoveryContract,
    runId: 'invoice-portal-poc-recovery',
    revision: 0,
    evidence: [],
    artifacts: receiptArtifacts.map((artifact, index) => ({
      ...artifact,
      binding: {
        ...artifact.binding,
        externalBusinessKey: `portal:other-tenant:invoice:UNRELATED-${index + 1}`,
      },
    })),
    actions: restoredLedger.outcomes(['submit']),
  })
  assert.equal(
    unrelatedReceiptCompletion.completed,
    false,
    'four unrelated receipt artifacts must not satisfy four target business keys by count alone',
  )
  assert.equal(portalProbeCalls, 4, 'recovery must issue exactly one read-only query per invoice')
  await assertState(page, (state) => {
    assert.equal(state.committedSubmissions, 4, 'read-only recovery must not submit the batch again')
    assert.equal(state.receiptCount, 4, 'read-only recovery must not create duplicate receipts')
  })

  const screenshotPath = process.env.POC_SCREENSHOT
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })

  await page.getByRole('button', { name: '生成待审核门户 Recipe' }).click()
  await assertText(page, '#toast', '已生成待审核 Recipe')
  console.log('invoice-portal-poc-test: PASS (4/4 receipts, 0 replayed submissions, 4/4 immutable artifacts)')
} finally {
  await browser.close()
  await control.close()
  await rm(root, { recursive: true, force: true })
}

async function assertState(page, assertion) {
  const state = await page.evaluate(() => window.__INVOICE_POC_STATE__)
  assertion(state)
}

async function assertText(root, selector, expected) {
  const text = (await root.locator(selector).textContent())?.replace(/\s+/g, '') || ''
  assert(
    text.includes(expected.replace(/\s+/g, '')),
    `Expected ${selector} to contain "${expected}", got "${text}"`,
  )
}
