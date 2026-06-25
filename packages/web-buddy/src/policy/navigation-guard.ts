const BLOCKED_PROTOCOLS = new Set(['file:', 'javascript:', 'data:', 'blob:'])

function parseAllowedDomains(): string[] {
  const raw = process.env.PLAYWRIGHT_ALLOWED_DOMAINS?.trim()
  if (!raw) return []
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
}

function hostnameMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase()
  const rule = pattern.toLowerCase()
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(2)
    return host === suffix || host.endsWith(`.${suffix}`)
  }
  return host === rule
}

export function validateNavigationUrl(url: string, originHost?: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` }
  }

  const allowDataUrls = process.env.PLAYWRIGHT_ALLOW_DATA_URLS === 'true'
  if (parsed.protocol === 'data:' && allowDataUrls) {
    return { ok: true, url: parsed }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: `Blocked protocol: ${parsed.protocol}` }
  }

  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `Blocked protocol: ${parsed.protocol}` }
  }

  const blockedLocal = process.env.PLAYWRIGHT_BLOCK_LOCALHOST !== 'false'
  if (blockedLocal) {
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
      return { ok: false, reason: `Blocked local/private host: ${parsed.hostname}` }
    }
  }

  const allowedDomains = parseAllowedDomains()
  if (allowedDomains.length > 0) {
    const allowed = allowedDomains.some((pattern) => hostnameMatches(parsed.hostname, pattern))
    if (!allowed) {
      return { ok: false, reason: `Host not in PLAYWRIGHT_ALLOWED_DOMAINS: ${parsed.hostname}` }
    }
  } else if (originHost) {
    const sameOrigin =
      parsed.hostname.toLowerCase() === originHost.toLowerCase() ||
      parsed.hostname.toLowerCase().endsWith(`.${originHost.toLowerCase()}`)
    if (!sameOrigin) {
      return {
        ok: false,
        reason: `Cross-domain navigation blocked. Stay on ${originHost} or set PLAYWRIGHT_ALLOWED_DOMAINS.`,
      }
    }
  }

  return { ok: true, url: parsed }
}
