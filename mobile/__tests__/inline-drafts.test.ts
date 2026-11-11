import { readInlineDraft, writeInlineDraft, forgetInlineDraft, clearInlineDrafts } from '../src/workbench/drafts'
import type { WorkItem } from '../src/workbench/model'
const item: WorkItem = { id: 'qa-draft', kind: 'memo', title: '原内容', status: 'open', dueAt: null, createdAt: 1, data: { updatedAt: 10, content: '原正文' } }
afterEach(clearInlineDrafts)
test('navigation drafts retain text and the original edit version, and can be saved or discarded independently', () => {
  writeInlineDraft({ item, title: '未保存的标题', content: '未保存的正文' })
  expect(readInlineDraft(item.id)).toMatchObject({ title: '未保存的标题', content: '未保存的正文', item: { data: { updatedAt: 10 } } })
  expect(readInlineDraft('another-item')).toBeUndefined()
  forgetInlineDraft(item.id)
  expect(readInlineDraft(item.id)).toBeUndefined()
})
test('clearing the unlocked session also clears all unsaved input', () => {
  writeInlineDraft({ item, title: '私密输入', content: '私密正文' })
  clearInlineDrafts()
  expect(readInlineDraft(item.id)).toBeUndefined()
})
