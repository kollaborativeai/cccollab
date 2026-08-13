import http from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageBus } from './message-bus.js'
import type { ActiveContext } from './context.js'
import type { SessionManager } from './session.js'
import type { ParsedMessage } from './types.js'
import { normalizeChannelName } from './context.js'
import { LOCAL_LOCATION } from './transport/index.js'
import { brokerHeartbeatMs, CCCOLLAB_LOGS_DIR } from './constants.js'

mkdirSync(CCCOLLAB_LOGS_DIR, { recursive: true })
const LOG_FILE = join(CCCOLLAB_LOGS_DIR, 'debug.log')
const RECONNECT_DELAY_MS = 2000
/** Slack on top of two beats, so ordinary jitter — a busy event loop, a slow
 *  write — cannot be mistaken for a dead stream. */
const READ_DEADLINE_HEADROOM_MS = 10_000

/**
 * How long an open-but-silent stream is tolerated before we call it dead.
 *
 * DERIVED from the broker's heartbeat, not written down twice. The two are a
 * matched pair: the deadline is only correct while it outlasts two beats, and
 * the heartbeat is a knob any operator can turn (`CCCOLLAB_HEARTBEAT_MS`). While
 * this was a 40s literal, `CCCOLLAB_HEARTBEAT_MS=60000` made every session
 * declare a perfectly healthy broker dead at 40s and reconnect 2s later,
 * forever — `connected` flapping with no fault anywhere, which is precisely the
 * honest health signal this feature exists to provide (cc#35). Measured at
 * scale model: 1 connection in 7s when the pair is sized correctly, 4 when it
 * is not, against a server that never closed or errored.
 *
 * Same shape as `LOCK_TIMEOUT_MS = CLERK_FETCH_TIMEOUT_MS + LOCK_HEADROOM_MS`
 * in `config/save.ts` (cc#33), for the same reason: constants that must hold an
 * ordering cannot be trusted to drift apart quietly.
 *
 * At the default heartbeat this is 15_000 * 2 + 10_000 = 40_000 — the value
 * that shipped, so nobody who never set the variable sees a change.
 */
export function readDeadlineMsFor(heartbeatMs: number = brokerHeartbeatMs()): number {
  return heartbeatMs * 2 + READ_DEADLINE_HEADROOM_MS
}

interface BrokerEventListenerOptions {
  brokerUrl: string
  messageBus: MessageBus
  sessionManager: SessionManager
  context: ActiveContext
  /** Override for the read deadline. Exists so a test can drive it in tens of
   *  milliseconds instead of waiting out the real one. */
  readDeadlineMs?: number
}

export interface BrokerLocalEvent {
  source: 'local'
  /** `stream_gap` is the broker admitting it could not honour our cursor: some
   *  events are gone for good. It is not traffic — it is a health fact. */
  type:
    | 'message'
    | 'topic_created'
    | 'topic_archived'
    | 'topic_unarchived'
    | 'broadcast'
    | 'stream_gap'
    | 'stream_hello'
  channel?: string
  topicId?: string
  /** Name of the topic `topicId` refers to. Carried on topic traffic so a
   *  channel watcher, which never joined the topic, can still name it. */
  topicName?: string
  topic?: { id: string; topic: string; channel?: string; creator: string; state?: string; createdAt?: string }
  sender?: string
  text?: string
  archivedBy?: string
  unarchivedBy?: string
  ts?: string
  /** Why the broker could not fill the gap. Only on `stream_gap`. */
  reason?: string
}

function isLocalEvent(data: unknown): data is BrokerLocalEvent {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).source === 'local'
}

export class BrokerEventListener {
  private readonly brokerUrl: string
  private readonly bus: MessageBus
  private readonly session: SessionManager
  private readonly context: ActiveContext
  private currentRequest: http.ClientRequest | null = null
  private stopped = false
  /** Whether an SSE response is open AND has spoken within the read deadline.
   *  This is the ONLY thing that carries local topic traffic into the session,
   *  so it is also the honest answer to "is my channel watch actually in effect
   *  right now?" — see `whoami`'s `watchingActive`. Deliberately more than "a
   *  socket is open": an open socket that answers 200 with the wrong
   *  content-type, or that has gone silent through a heartbeat window, is not a
   *  stream that will ever deliver anything. */
  private connected = false
  /** True while a reconnect timer is already queued. Without this, a single
   *  socket teardown can fan out into multiple reconnects — req.on('error')
   *  and res.on('end') can both fire, each scheduling its own — and we end
   *  up with two live streams delivering every event twice. */
  private reconnectPending = false
  /** Cursor into the broker's event sequence: the id of the last event we
   *  actually processed. Sent as `Last-Event-ID` on reconnect so the broker can
   *  replay the gap. Without it, a dropped stream silently swallows every event
   *  published while we were away — and we would still call ourselves healthy.
   *  THAT is the bug this exists to kill. */
  private lastEventId: string | undefined
  /** Set when the broker tells us it could not honour our cursor. Sticky: once
   *  we know events were lost, no later reconnect makes that untrue. An oracle
   *  that cannot say "I may have missed messages" is unsound — a socket being
   *  open now says nothing about what happened while it was not. */
  private missedEvents = false
  /** Watchdog for a stream that is open but carrying nothing. A socket staying
   *  up proves only that something is on the other end — not that it is the
   *  broker, and not that it still works. Reset by every `data` event, which
   *  the broker's heartbeat guarantees will keep arriving on a healthy stream. */
  private readDeadline: NodeJS.Timeout | null = null
  /** The watchdog interval actually in force — derived from the broker's
   *  heartbeat unless a caller overrode it. Readable so the pair's invariant
   *  (deadline outlasts two beats) can be asserted where it is USED, rather
   *  than only on the helper that computes it. */
  readonly readDeadlineMs: number

  constructor(options: BrokerEventListenerOptions) {
    this.brokerUrl = options.brokerUrl
    this.bus = options.messageBus
    this.session = options.sessionManager
    this.context = options.context
    this.readDeadlineMs = options.readDeadlineMs ?? readDeadlineMsFor()
  }

  async start(): Promise<void> {
    this.stopped = false
    this.connect()
    this.log('SSE listener started')
  }

  /** True only while an SSE response is open. False before `start()`, during
   *  the reconnect window, and after `stop()`. Says nothing about whether we
   *  missed anything while it was closed — for that, see `mayHaveMissedEvents`. */
  isConnected(): boolean {
    return this.connected
  }

  /** Did the broker ever fail to replay a gap for us? If true, this session has
   *  a hole in its history and must say so rather than report itself healthy. */
  mayHaveMissedEvents(): boolean {
    return this.missedEvents
  }

  /** Drop the SSE connection; the listener reconnects on its own and resumes
   *  from its cursor. Exists so the reconnect gap — the failure mode that hid
   *  behind an always-healthy stream — can actually be exercised, in tests and
   *  by a caller who suspects a wedged socket. Destroy alone: the socket
   *  teardown fires res.on('close')/res.on('error')/req.on('error'), each of
   *  which already schedules the reconnect. Calling scheduleReconnect() here in
   *  addition would open TWO sockets (proven: connections:3 for 2 sessions,
   *  message delivered twice). */
  dropStream(): void {
    this.currentRequest?.destroy()
  }

  stop(): void {
    this.stopped = true
    this.connected = false
    this.clearReadDeadline()
    if (this.currentRequest) {
      this.currentRequest.destroy()
      this.currentRequest = null
    }
  }

  private connect(): void {
    if (this.stopped) return

    const url = `${this.brokerUrl}/events`
    this.log(`Connecting to broker at ${url}`)

    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    // Resume where we left off. A fresh listener has no cursor and is
    // forward-only by design; a RECONNECTING one must not be.
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId

    const req = http.get(url, { headers }, (res) => {
      let buffer = ''
      let pendingId: string | undefined

      // Wired FIRST because the rejection path below destroys this stream, and
      // a destroy that races a socket reset would emit 'error' on a stream with
      // no listener — an uncaught throw that takes the whole session down.
      res.on('error', (err) => {
        this.log(`SSE response error: ${err.message}`)
        this.scheduleReconnect()
      })

      // A 200 status line is NOT evidence that the broker is on the other end.
      // The session pins the broker's port once at startup and never
      // rediscovers it, so once the broker dies anything that binds that port
      // answers 200 — politely, forever, carrying nothing, emitting neither
      // 'end' nor 'error'. Trusting the status line alone is what let `whoami`
      // report `connected: true` for a permanently deaf session.
      const contentType = (res.headers['content-type'] ?? '').toLowerCase().trim()
      if (res.statusCode !== 200 || !contentType.startsWith('text/event-stream')) {
        this.log(`SSE rejected: status=${res.statusCode ?? 'unknown'} content-type="${contentType}"`)
        // Destroy rather than leave the socket dangling: nothing else will ever
        // tear it down, and the response holds it open.
        res.destroy()
        this.scheduleReconnect()
        return
      }
      this.connected = true
      this.armReadDeadline()

      // Decode as UTF-8 across chunk boundaries. `chunk.toString()` per Buffer
      // splits multi-byte characters at the seam into U+FFFD, which is still
      // legal JSON so nothing errors — and a resume replay can dump up to
      // REPLAY_CAPACITY frames in one synchronous write, making the seam
      // materially likely.
      res.setEncoding('utf8')

      res.on('data', (chunk: string | Buffer) => {
        // Any byte proves the stream is alive — including a heartbeat comment
        // frame, which is the only thing that arrives on an idle channel.
        this.armReadDeadline()
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          // SSE allows optional space after the colon (`id:1` and `id: 1`).
          if (line.startsWith('id:')) {
            pendingId = line.slice(3).replace(/^\s*/, '').trim()
            continue
          }
          if (line.startsWith('data:')) {
            const json = line.slice(5).replace(/^\s*/, '')
            try {
              const parsed = JSON.parse(json) as Record<string, unknown>
              if (isLocalEvent(parsed)) {
                this.processLocalEvent(parsed)
                // Advance only after a frame we actually examined. An
                // unparseable frame must stay at the cursor so reconnect
                // re-offers it from the replay buffer — advancing past it
                // marked it consumed forever. Deliberate DROPPED non-local
                // events still advance: they were examined and rejected.
                if (pendingId) this.lastEventId = pendingId
              } else {
                this.log(`DROPPED: non-local event ignored: ${json.slice(0, 120)}`)
                if (pendingId) this.lastEventId = pendingId
              }
            } catch {
              this.log(`SSE parse error: ${json}`)
              // Do NOT advance lastEventId — the frame was never dispatched.
            }
            pendingId = undefined
          }
        }
      })

      res.on('end', () => {
        this.log('SSE connection ended')
        this.scheduleReconnect()
      })

      // The backstop for every teardown that emits neither 'end' nor 'error' —
      // and there are several. Safe to add: `reconnectPending` swallows the
      // duplicate when 'end' or 'error' already fired for the same socket.
      res.on('close', () => {
        this.log('SSE connection closed')
        this.scheduleReconnect()
      })
    })

    req.on('error', (err) => {
      this.log(`SSE request error: ${err.message}`)
      this.scheduleReconnect()
    })

    this.currentRequest = req
  }

  /** (Re)start the silence watchdog. `.unref()`: a listener waiting for the
   *  broker to say something must never be the reason a process cannot exit. */
  private armReadDeadline(): void {
    this.clearReadDeadline()
    this.readDeadline = setTimeout(() => {
      this.log(`SSE read deadline: no data for ${this.readDeadlineMs}ms, treating the stream as dead`)
      // Set here rather than left to the teardown below: the moment we decide
      // the stream is dead, `whoami` must stop claiming otherwise — not one
      // socket round-trip later. Destroying then fires 'close', which routes
      // through scheduleReconnect() and resumes from the cursor.
      this.connected = false
      this.currentRequest?.destroy()
    }, this.readDeadlineMs)
    this.readDeadline.unref()
  }

  private clearReadDeadline(): void {
    if (!this.readDeadline) return
    clearTimeout(this.readDeadline)
    this.readDeadline = null
  }

  private scheduleReconnect(): void {
    // Every teardown funnels through here, so this is the one honest place to
    // say "we are not connected" and to disarm the watchdog. Before the early
    // returns on purpose: a future teardown path gets both for free instead of
    // leaving `whoami` reporting connected:true on a dead socket, or leaving a
    // stale deadline armed to shoot down the NEXT connection.
    this.connected = false
    this.clearReadDeadline()
    if (this.stopped) return
    if (this.reconnectPending) return
    this.reconnectPending = true
    this.log(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`)
    setTimeout(() => {
      this.reconnectPending = false
      this.connect()
    }, RECONNECT_DELAY_MS)
  }

  processLocalEvent(event: BrokerLocalEvent): void {
    this.log(
      `LOCAL EVENT: type=${event.type} channel=${event.channel ?? 'none'} topicId=${event.topicId ?? 'none'} sender=${event.sender ?? 'none'}`,
    )
    this.handleLocalEvent(event).catch((err) => {
      this.log(`LOCAL HANDLE ERROR: ${err}`)
    })
  }

  private log(msg: string): void {
    const who = this.session.hasName() ? this.session.displayName : `pid${process.pid}`
    const line = `[${new Date().toISOString()}] [${who}] ${msg}\n`
    appendFileSync(LOG_FILE, line)
  }

  // Channel gates are qualified with LOCAL_LOCATION: this listener only ever
  // handles local broker events, and an unqualified lookup matches a
  // same-named channel at ANY location — a cross-org leak once remote watch
  // lands (KAI-413). `isTopicJoined` takes no location (topics are keyed by
  // threadTs alone today); only the channel half is location-qualified.
  private channelSubscribed(channel: string | undefined): boolean {
    if (!channel) return false
    return this.context.isChannelSubscribed(channel, LOCAL_LOCATION)
  }

  /**
   * Should topic traffic reach this session? Normally only for topics it
   * joined. A channel watcher sees all of it, including topics created after
   * it subscribed: the gate is per-event, so there is no list to keep current
   * and nothing to forget to join.
   */
  private topicVisible(channel: string, topicId: string | undefined): boolean {
    if (!topicId) return false
    return this.context.isTopicJoined(topicId) || this.context.isChannelWatched(channel, LOCAL_LOCATION)
  }

  private async handleLocalEvent(event: BrokerLocalEvent): Promise<void> {
    switch (event.type) {
      case 'stream_hello':
        // Carries no payload: its only job is the `id:` line beside it, which
        // gives a brand-new listener a cursor before it has heard any traffic.
        return
      case 'stream_gap': {
        // The broker cannot replay what we missed. Record it (whoami must be
        // able to say "I may have missed messages") AND tell the session
        // outright — an orchestrator that has to run whoami to discover it is
        // deaf is exactly the confidently-blind user this ticket exists for.
        //
        // Push once per LOCAL subscribed channel — a session with joined
        // topics but no channel-wide watch has the same silent hole. If the
        // session sits in zero local channels there is nowhere honest to push
        // to; whoami still reports mayHaveMissedMessages, so no info is lost.
        this.missedEvents = true
        this.log(`STREAM GAP: ${event.reason ?? 'unknown reason'}`)
        // LOCAL_LOCATION, not the bare literal — the one proactive alarm path
        // must not drift from every other local gate in this file.
        const localChannels = this.context.getSubscribedChannels().filter((c) => c.location === LOCAL_LOCATION)
        for (const channel of localChannels) {
          await this.bus.push({
            sender: 'cccollab',
            text:
              `WARNING: the event stream reconnected with a gap (${event.reason ?? 'reason unknown'}). ` +
              `Messages published while it was down were NOT delivered to this session. ` +
              `Local channel broadcasts cannot be reconstructed after a gap — re-read any ` +
              `topics you care about with read_topic_messages (joined topics only). ` +
              `whoami.eventStream.mayHaveMissedMessages stays true for this session.`,
            ts: new Date().toISOString(),
            channel: channel.name,
            channelName: channel.name,
            threadTs: undefined,
          })
        }
        return
      }
      case 'topic_created': {
        if (!event.topic) {
          this.log(`DROPPED: topic_created with no topic field`)
          return
        }
        const channel = normalizeChannelName(event.channel ?? event.topic.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED topic_created: channel "${channel}" not subscribed`)
          return
        }
        if (event.topic.creator && this.session.isExactSelf(event.topic.creator)) {
          this.log(`DROPPED: self topic_created from ${event.topic.creator}`)
          return
        }
        // Carries the topic id so a channel watcher can act on the
        // notification (join, read, archive) without guessing from the title.
        const msg: ParsedMessage = {
          sender: event.topic.creator,
          text: `New topic in "${channel}": "${event.topic.topic}"`,
          ts: event.topic.createdAt ?? new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topic.id,
          topicName: event.topic.topic,
        }
        this.log(`PUSHING topic_created to Claude: "${event.topic.topic}"`)
        await this.bus.push(msg)
        return
      }
      case 'message': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED message: channel "${channel}" not subscribed`)
          return
        }
        if (!this.topicVisible(channel, event.topicId)) {
          this.log(`DROPPED message: topic ${event.topicId ?? 'none'} not joined and channel not watched`)
          return
        }
        if (event.sender && this.session.isExactSelf(event.sender)) {
          this.log(`DROPPED: self message from ${event.sender}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.sender ?? 'unknown',
          text: event.text ?? '',
          ts: event.ts ?? new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topicId,
          ...(event.topicName ? { topicName: event.topicName } : {}),
        }
        this.log(`PUSHING message to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
        await this.bus.push(msg)
        return
      }
      case 'topic_archived': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED topic_archived: channel "${channel}" not subscribed`)
          return
        }
        if (!this.topicVisible(channel, event.topicId)) {
          this.log(`DROPPED topic_archived: topic ${event.topicId ?? 'none'} not joined and channel not watched`)
          return
        }
        if (event.archivedBy && this.session.isExactSelf(event.archivedBy)) {
          this.log(`DROPPED: self topic_archived from ${event.archivedBy}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.archivedBy ?? 'unknown',
          text: 'Topic archived',
          ts: new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topicId,
          ...(event.topicName ? { topicName: event.topicName } : {}),
        }
        this.log(`PUSHING topic_archived to Claude`)
        await this.bus.push(msg)
        return
      }
      case 'topic_unarchived': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED topic_unarchived: channel "${channel}" not subscribed`)
          return
        }
        if (!this.topicVisible(channel, event.topicId)) {
          this.log(`DROPPED topic_unarchived: topic ${event.topicId ?? 'none'} not joined and channel not watched`)
          return
        }
        if (event.unarchivedBy && this.session.isExactSelf(event.unarchivedBy)) {
          this.log(`DROPPED: self topic_unarchived from ${event.unarchivedBy}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.unarchivedBy ?? 'unknown',
          text: 'Topic unarchived',
          ts: new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topicId,
          ...(event.topicName ? { topicName: event.topicName } : {}),
        }
        this.log(`PUSHING topic_unarchived to Claude`)
        await this.bus.push(msg)
        return
      }
      case 'broadcast': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED broadcast: channel "${channel}" not subscribed`)
          return
        }
        if (event.sender && this.session.isExactSelf(event.sender)) {
          this.log(`DROPPED: self broadcast from ${event.sender}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.sender ?? 'unknown',
          text: event.text ?? '',
          ts: event.ts ?? new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: undefined,
        }
        this.log(`PUSHING broadcast to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
        await this.bus.push(msg)
        return
      }
      default: {
        // Without this arm an unknown type is swallowed with no log line —
        // and isLocalEvent already accepted it because it only checks source.
        const unknownType = (event as { type?: string }).type ?? 'undefined'
        this.log(`DROPPED: unknown local event type "${unknownType}"`)
        return
      }
    }
  }
}
