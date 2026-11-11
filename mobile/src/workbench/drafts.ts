import type { WorkItem } from './model'
interface InlineDraft { item: WorkItem; title: string; content: string }
// Keep unfinished input while navigating. Nothing is written to plaintext storage or synced.
const drafts = new Map<string, InlineDraft>()
export const readInlineDraft = (id: string) => drafts.get(id)
export const writeInlineDraft = (draft: InlineDraft) => { drafts.set(draft.item.id, { ...draft }) }
export const forgetInlineDraft = (id: string) => { drafts.delete(id) }
export const clearInlineDrafts = () => drafts.clear()
