"use strict";
// Guards that keep a WhatsApp number out of Meta's spam heuristics. People who wrote to a number first can always be
// answered; reaching out to people who never wrote is capped per day (lower while a freshly linked number warms up),
// limited to a few unanswered messages per person, and stopped while WhatsApp restricts the number.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProtectionBook = void 0;
exports.typingDelayMs = typingDelayMs;
const DAY = 24 * 3600_000;
const COLD_RECORD_TTL = 30 * DAY;
class ProtectionBook {
    policy;
    numbers = new Map();
    constructor(policy) {
        this.policy = policy;
    }
    contacts(numberId) {
        let contacts = this.numbers.get(numberId);
        if (!contacts)
            this.numbers.set(numberId, (contacts = new Map()));
        return contacts;
    }
    markInbound(numberId, contact, at) {
        const record = this.contacts(numberId).get(contact) ?? {};
        record.inboundAt = at;
        record.coldSends = 0;
        this.contacts(numberId).set(contact, record);
    }
    isWarm(numberId, contact) {
        return Boolean(this.numbers.get(numberId)?.get(contact)?.inboundAt);
    }
    warmingUp(state, now) {
        return Boolean(state.linkedAt && this.policy.warmupDays > 0 && now - state.linkedAt < this.policy.warmupDays * DAY);
    }
    stats(numberId, state, now) {
        const warmingUp = this.warmingUp(state, now);
        let newChatsToday = 0;
        for (const record of this.numbers.get(numberId)?.values() ?? []) {
            if (record.startedAt && now - record.startedAt < DAY)
                newChatsToday++;
        }
        return {
            newChatsToday,
            newChatLimit: warmingUp ? this.policy.warmupNewChatsPerDay : this.policy.newChatsPerDay,
            warmingUp,
            warmupDaysLeft: warmingUp ? Math.ceil((this.policy.warmupDays * DAY - (now - state.linkedAt)) / DAY) : 0,
            restricted: Boolean(state.restrictedUntil && now < state.restrictedUntil)
        };
    }
    check(numberId, contact, state, now) {
        if (this.isWarm(numberId, contact))
            return { allowed: true };
        if (state.restrictedUntil && now < state.restrictedUntil) {
            return {
                allowed: false,
                reason: `this number is restricted by WhatsApp from starting new chats until ${new Date(state.restrictedUntil).toISOString()}. Chats with people who wrote first still work.`
            };
        }
        const record = this.numbers.get(numberId)?.get(contact);
        if ((record?.coldSends ?? 0) >= this.policy.coldMessagesPerContact) {
            return { allowed: false, reason: `this contact has not replied to the last ${this.policy.coldMessagesPerContact} messages; wait for a reply before sending more.` };
        }
        if (record?.startedAt && now - record.startedAt < DAY)
            return { allowed: true };
        const { newChatsToday, newChatLimit, warmingUp } = this.stats(numberId, state, now);
        if (newChatsToday >= newChatLimit) {
            return {
                allowed: false,
                reason: warmingUp
                    ? `this number is warming up and has reached its ${newChatLimit} new conversations for today. Contacts who wrote first can still be answered.`
                    : `this number has started ${newChatLimit} new conversations today, the daily limit that protects it from WhatsApp restrictions. Contacts who wrote first can still be answered.`
            };
        }
        return { allowed: true };
    }
    recordSend(numberId, contact, now) {
        if (this.isWarm(numberId, contact))
            return;
        const record = this.contacts(numberId).get(contact) ?? {};
        if (!record.startedAt || now - record.startedAt >= DAY)
            record.startedAt = now;
        record.coldSends = (record.coldSends ?? 0) + 1;
        this.contacts(numberId).set(contact, record);
    }
    forget(numberId) {
        this.numbers.delete(numberId);
    }
    prune(now) {
        for (const contacts of this.numbers.values()) {
            for (const [contact, record] of contacts) {
                if (!record.inboundAt && (!record.startedAt || now - record.startedAt > COLD_RECORD_TTL))
                    contacts.delete(contact);
            }
        }
    }
    toJSON() {
        return Object.fromEntries([...this.numbers].map(([id, contacts]) => [id, Object.fromEntries(contacts)]));
    }
    load(data) {
        this.numbers = new Map(Object.entries(data ?? {}).map(([id, contacts]) => [id, new Map(Object.entries(contacts ?? {}))]));
    }
}
exports.ProtectionBook = ProtectionBook;
// How long to show "typing…" before a message: grows with length, stays within a few seconds.
function typingDelayMs(text, random = Math.random) {
    const base = Math.min(5000, Math.max(800, 600 + text.length * 25));
    return Math.round(base + random() * 900);
}
