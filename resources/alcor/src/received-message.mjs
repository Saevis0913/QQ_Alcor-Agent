import { randomUUID } from 'node:crypto';

export class ReceiveProgress {
  instance = randomUUID();
  totals = { cyclesStarted:0, cyclesCompleted:0, inputs:0, unrecognized:0, parseErrors:0, duplicates:0,
    staleMessages:0, metadataErrors:0, metadataTimeouts:0, messagesPublished:0, idleTimeouts:0 };
  lastStartedAt = null;
  lastFinishedAt = null;
  pendingSince = null;
  pendingSession = null;

  start(session) {
    this.totals.cyclesStarted++;
    this.pendingSession = session;
    this.pendingSince = performance.now();
    this.lastStartedAt = new Date().toISOString();
  }
  finish() {
    this.totals.cyclesCompleted++;
    this.pendingSince = null;
    this.pendingSession = null;
    this.lastFinishedAt = new Date().toISOString();
  }
  snapshot(session) {
    return { instance:this.instance, session, ...this.totals, lastStartedAt:this.lastStartedAt,
      lastFinishedAt:this.lastFinishedAt, pendingSession:this.pendingSession,
      pendingMs:this.pendingSince === null ? null : Math.max(0, Math.floor(performance.now() - this.pendingSince)) };
  }
}

// Group directory enrichment changes sender metadata and at/reply fields. Keep the
// original segments (including their private media descriptors) until enrichment succeeds.
async function enrichForDelivery(backend, event) {
  const work = { ...event };
  if (Array.isArray(event.message)) {
    work.message = event.message.map(segment => (segment?.type === 'at' || segment?.type === 'reply')
      ? {...segment, data:{...segment.data}} : segment);
  }
  if (event.sender) work.sender = {...event.sender};
  let timer;
  const expired = Symbol('expired');
  try {
    const result = await Promise.race([backend.directory.enrich(work), new Promise(resolve => {
      timer = setTimeout(resolve, 1500, expired);
      timer.unref();
    })]);
    if (result === expired) {
      backend.receiveProgress.totals.metadataTimeouts++;
      return;
    }
    if (work.sender) event.sender = work.sender;
    if (work.member_scan_error !== undefined) event.member_scan_error = work.member_scan_error;
    event.message = work.message;
  } catch {
    backend.receiveProgress.totals.metadataErrors++;
  } finally {
    clearTimeout(timer);
  }
}

export async function publishDecodedMessage(backend, event, generation) {
  const counts = backend.receiveProgress.totals;
  const key = [event.self_id, event.group_id || 'private', event.user_id, event.sequence, event.time].map(String).join(':');
  if (backend.seen.has(key)) { counts.duplicates++; return; }

  // Private text has no group directory fields. Commit it in the current session's turn.
  if (event.group_id) await enrichForDelivery(backend, event);
  if (generation !== backend.receiveGeneration || !backend.receiving) { counts.staleMessages++; return; }
  if (backend.seen.has(key)) { counts.duplicates++; return; }

  event.message_id = backend.messageCounter++;
  backend.rememberMedia(event);
  backend.messages.set(event.message_id, event);
  if (backend.messages.size > 1000) backend.messages.delete(backend.messages.keys().next().value);

  // A stale session or an abandoned lookup must never reserve a key for an unpublished message.
  backend.seen.add(key);
  if (backend.seen.size > 2048) backend.seen.delete(backend.seen.values().next().value);
  backend.confirmed = true;
  backend.events++;
  backend.lastReceivedAt = new Date().toISOString();
  if (backend.onEvent) {
    backend.onEvent(event);
    counts.messagesPublished++;
  }
}
