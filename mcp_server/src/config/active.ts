import { LOCAL_LOCATION, type CccollabConfig } from './schema.js'

/**
 * Resolved active-state triple produced by `resolveActive`. Each level
 * is optional: a config can have no active location at all, an active
 * location without an active channel, and so on.
 */
export interface ResolvedActive {
  activeLocation?: string
  activeChannel?: { location: string; name: string }
  activeTopic?: { location: string; channel: string; name: string }
}

/**
 * Cascade-resolve the `active: true` flags in a merged config and
 * validate the "exactly one active at each level" rule.
 *
 * Semantics:
 *
 * - An active topic cascades upward: its channel and location are
 *   considered active even when their own `active` flags are absent.
 * - An active channel cascades to its location.
 * - Explicit `active: true` at a level is honoured directly.
 * - If the same level has zero active entries (explicit or cascaded),
 *   that level simply has no active - not an error.
 * - If the same level has two or more active entries (explicit or
 *   cascaded), we throw a message naming the level and the offenders
 *   so the user can fix their config.
 *
 * Also validates structural invariants that can't be expressed in the
 * zod schema:
 *
 * - Any non-`local` location in the config MUST have a `url` string.
 */
export function resolveActive(config: CccollabConfig): ResolvedActive {
  const locations = config.locations ?? {}

  // 1. Validate url-on-non-local across every configured location,
  //    not just active ones. A location without a URL can't spin up
  //    a transport so catching this at resolve time saves a confusing
  //    runtime failure later.
  for (const [name, location] of Object.entries(locations)) {
    if (!location) continue
    if (name === LOCAL_LOCATION) continue
    if (typeof location.url !== 'string' || location.url.trim() === '') {
      throw new Error(`cccollab config: location "${name}" must have a "url" (non-local locations require one).`)
    }
  }

  // 2. Walk bottom-up: topic → channel → location, cascading actives
  //    as we go. For each level we accumulate the set of active entries
  //    (explicit or cascaded) and fail if more than one is active.
  const activeLocations = new Set<string>()
  let activeChannel: { location: string; name: string } | undefined
  let activeTopic: { location: string; channel: string; name: string } | undefined

  // Pass 1: topic -> channel cascade.
  // A channel with >1 active topic is an error. A channel inherits
  // active from its topic. Multiple active channels in one location are
  // caught in the location pass below.
  const activeChannelsByLocation = new Map<string, Set<string>>()

  for (const [locationName, location] of Object.entries(locations)) {
    if (!location) continue
    const channels = location.channels ?? {}
    for (const [channelName, channel] of Object.entries(channels)) {
      if (!channel) continue
      const topics = channel.topics ?? {}
      const explicitlyActiveTopics = Object.entries(topics)
        .filter(([, t]) => t?.active === true)
        .map(([name]) => name)
      if (explicitlyActiveTopics.length > 1) {
        throw new Error(
          `cccollab config: channel "${channelName}" in location "${locationName}" has ` +
            `exactly one active topic required, found ${explicitlyActiveTopics.length}: ${explicitlyActiveTopics.join(', ')}.`,
        )
      }
      const channelIsActive = channel.active === true || explicitlyActiveTopics.length > 0
      if (channelIsActive) {
        const set = activeChannelsByLocation.get(locationName) ?? new Set<string>()
        set.add(channelName)
        activeChannelsByLocation.set(locationName, set)
      }
      if (explicitlyActiveTopics.length === 1) {
        const topicName = explicitlyActiveTopics[0]!
        // Guard against multiple topic actives across channels - we
        // don't impose "one topic across all channels" here; each
        // channel can have one, and the winning one is the one whose
        // channel cascade produces the single active channel below.
        // Hold the candidate so the post-pass can pick it once we know
        // the active channel.
        activeTopic = { location: locationName, channel: channelName, name: topicName }
      }
    }
    // Validate "exactly one active channel per location".
    const activeInLocation = activeChannelsByLocation.get(locationName)
    if (activeInLocation && activeInLocation.size > 1) {
      throw new Error(
        `cccollab config: location "${locationName}" has exactly one active channel required, found ${activeInLocation.size}: ${[...activeInLocation].join(', ')}.`,
      )
    }
  }

  // Pass 2: channel -> location cascade. A location is active if its
  // own flag is set OR it has any active channel.
  for (const [locationName, location] of Object.entries(locations)) {
    if (!location) continue
    const explicitlyActive = location.active === true
    const hasActiveChannel = (activeChannelsByLocation.get(locationName)?.size ?? 0) > 0
    if (explicitlyActive || hasActiveChannel) {
      activeLocations.add(locationName)
    }
  }

  if (activeLocations.size > 1) {
    throw new Error(
      `cccollab config: exactly one active location required, found ${activeLocations.size}: ${[...activeLocations].join(', ')}.`,
    )
  }

  const activeLocation: string | undefined = activeLocations.size === 1 ? [...activeLocations][0]! : undefined

  // Derive the active channel + topic from the active location. The
  // topic candidate recorded in pass 1 only qualifies if its location
  // and channel match the active ones.
  if (activeLocation !== undefined) {
    const activeSet = activeChannelsByLocation.get(activeLocation)
    if (activeSet && activeSet.size === 1) {
      const channelName = [...activeSet][0]!
      activeChannel = { location: activeLocation, name: channelName }
      if (activeTopic && (activeTopic.location !== activeLocation || activeTopic.channel !== channelName)) {
        activeTopic = undefined
      }
    } else {
      // Either no active channel, or (can't happen given the earlier
      // size > 1 throw) more than one.
      activeChannel = undefined
      activeTopic = undefined
    }
  } else {
    activeChannel = undefined
    activeTopic = undefined
  }

  return {
    activeLocation,
    activeChannel,
    activeTopic,
  }
}
