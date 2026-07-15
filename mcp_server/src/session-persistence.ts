import type { ActiveContext } from './context.js'
import { SESSION_STATE_VERSION, type SessionState } from './session-state.js'
import type { Transport } from './transport/index.js'

/**
 * Capture the live context as the state to persist (KAI-415).
 *
 * A whole snapshot, not a delta: it is a handful of names and ids, and a
 * complete rewrite means the writer never has to read the previous file,
 * which is what lets `saveSessionState` skip locking entirely.
 */
export function snapshotSessionState(sessionId: string, context: ActiveContext, now = Date.now()): SessionState {
  const activeChannel = context.getActiveChannelRef()
  return {
    version: SESSION_STATE_VERSION,
    sessionId,
    channels: context.getSubscribedChannels().map((c) => ({
      name: c.name,
      location: c.location,
      source: c.source,
    })),
    topics: context.getJoinedTopics().map((t) => ({
      id: t.threadTs,
      name: t.topicName,
      channel: t.channel,
      location: t.location,
    })),
    ...(activeChannel ? { activeChannel: { name: activeChannel.name, location: activeChannel.location } } : {}),
    // `getThreadTs` throws when there is no active topic, so gate on
    // `hasTopic` — persisting a stale id would point a restored session at
    // a topic it had already left.
    ...(context.hasTopic() ? { activeTopic: context.getThreadTs() } : {}),
    updatedAt: now,
  }
}

/**
 * Rebuild a session's subscriptions from its persisted state (KAI-415).
 *
 * This deliberately does NOT reuse the config auto-subscribe loop in
 * `server.ts`, even though it looks like the same job. That loop resolves
 * topics BY NAME and CREATES the ones it cannot find — correct for a
 * declarative `cccollab.json` ("these topics should exist"), actively
 * wrong for a restore ("these topics existed when I last looked"). A
 * name-based restore has two failure modes this one is built to avoid:
 *
 *   1. A topic archived before the restart is resurrected — every restart,
 *      forever, with no way to make it stop except editing config.
 *   2. A NEW topic that happens to reuse the old name is silently joined,
 *      putting the session in a room it never asked for.
 *
 * So: look up by id, join what is still there and active, and quietly skip
 * everything else. A restore that recovers nothing is a no-op; a restore
 * that invents state is a bug.
 *
 * Every failure is non-fatal. This runs on the startup path, where the
 * worst outcome is not "a subscription was missed" but "the session would
 * not start at all" — the floor here is today's behaviour (no restore).
 */
export interface RestoreDeps {
  sessionName: string
  context: ActiveContext
  /** Resolve a location name to its live transport, or undefined when that
   *  location no longer exists / never attached. */
  transportFor: (location: string) => Transport | undefined
}

export interface RestoreResult {
  channels: number
  topics: number
  /** Persisted topics that could not be restored: deleted, archived, or
   *  unreachable. Reported so a restore that silently recovers nothing is
   *  distinguishable in the log from one that had nothing to recover. */
  skippedTopics: number
}

export async function restoreSubscriptions(state: SessionState, deps: RestoreDeps): Promise<RestoreResult> {
  const result: RestoreResult = { channels: 0, topics: 0, skippedTopics: 0 }

  for (const channel of state.channels) {
    const transport = deps.transportFor(channel.location)
    if (!transport || !transport.enabled) continue
    try {
      await transport.joinChannel({ sessionName: deps.sessionName, channel: channel.name })
    } catch (err) {
      // The wire join failed, so we do NOT record the subscription
      // locally. A context that claims a seat the broker never granted is
      // the exact silent-drop failure KAI-415 exists to fix, just inverted.
      warn(`channel "${channel.name}" at "${channel.location}"`, err)
      continue
    }
    deps.context.joinChannel(channel.name, 'restored', channel.location)
    result.channels++
  }

  for (const topic of state.topics) {
    const transport = deps.transportFor(topic.location)
    if (!transport || !transport.enabled) {
      result.skippedTopics++
      continue
    }
    try {
      // By id. Never by name, never create — see the module comment.
      const live = await transport.getTopicById({ sessionName: deps.sessionName, topicId: topic.id })
      if (!live || live.state === 'archived') {
        result.skippedTopics++
        continue
      }
      await transport.joinTopic({ sessionName: deps.sessionName, topicId: topic.id })
      // Throws if the topic's channel didn't restore above; caught below
      // and counted as skipped rather than taking the startup down.
      deps.context.joinTopic(topic.id, live.topic, topic.channel, topic.location)
      result.topics++
    } catch (err) {
      warn(`topic "${topic.name}" (${topic.id}) at "${topic.location}"`, err)
      result.skippedTopics++
    }
  }

  // Active pointers last: `context.joinTopic` makes each topic active as a
  // side effect, so the loop above leaves the LAST-restored topic active.
  // Without this the focused topic would silently drift on every restart.
  if (state.activeChannel && deps.context.isChannelSubscribed(state.activeChannel.name, state.activeChannel.location)) {
    try {
      deps.context.setActiveChannel(state.activeChannel.name, state.activeChannel.location)
    } catch (err) {
      warn(`active channel "${state.activeChannel.name}"`, err)
    }
  }
  // Clear BEFORE re-pointing, never merely re-point: `joinTopic` focuses
  // as a side effect, so the loop above always leaves SOME topic active.
  // Re-pointing alone would leave the last-restored one active for a
  // session that had no active topic, or whose active topic was archived —
  // inventing focus the session never had. A restore that recovers nothing
  // is a no-op; a restore that invents state is a bug.
  deps.context.clearActiveTopic()
  if (state.activeTopic !== undefined) {
    const active = state.topics.find((t) => t.id === state.activeTopic)
    // Only re-point at a topic that actually restored — `isTopicJoined`
    // is the check, not the persisted list, so an archived/deleted active
    // topic leaves the session with no active topic rather than a
    // dangling pointer to a room it isn't in.
    if (active && deps.context.isTopicJoined(active.id)) {
      deps.context.joinTopic(active.id, active.name, active.channel, active.location)
    }
  }

  return result
}

function warn(what: string, err: unknown): void {
  console.error(`[cccollab] Restore skipped ${what}: ${err instanceof Error ? err.message : String(err)}`)
}
