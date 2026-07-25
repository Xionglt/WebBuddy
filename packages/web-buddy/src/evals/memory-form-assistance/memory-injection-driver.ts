import type { LifecycleMemoryContextBatch } from '../../memory/context-provider.js'
import {
  isContextItemEligible,
  validateContextItem,
  type WebTaskRuntimeDriver,
  type WebTaskRuntimeRequest,
} from '../../task/contracts.js'

export function createMemoryInjectionDriver(input: {
  downstream: WebTaskRuntimeDriver
  batchProvider(request: WebTaskRuntimeRequest): Promise<LifecycleMemoryContextBatch>
}): { driver: WebTaskRuntimeDriver; batch: () => LifecycleMemoryContextBatch | undefined } {
  let latest: LifecycleMemoryContextBatch | undefined
  return {
    driver: {
      async execute(request) {
        latest = undefined
        const batch = await input.batchProvider(request)
        const memoryItems = batch.contextItems
        for (const item of memoryItems) validateContextItem(item)
        latest = batch
        const contextItems = [...request.contextItems, ...memoryItems]
          .filter((item) => isContextItemEligible(item))
        const ids = contextItems.map((item) => item.id)
        if (new Set(ids).size !== ids.length) {
          throw new Error('Runtime memory context produced duplicate ContextItem ids.')
        }
        return input.downstream.execute({ ...request, contextItems })
      },
    },
    batch: () => latest,
  }
}
