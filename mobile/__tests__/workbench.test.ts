import { autoSchedule, dayEnd, estimateMinutes, mergeWorkItems, parseSchedule, type WorkItem } from '../src/workbench/model'
const at = (time: string) => parseSchedule('2026-11-11', time)!
const item = (id: string, minutes: number, extra: Partial<WorkItem['data']> = {}): WorkItem => ({ id, kind: 'todo', title: id, status: 'open', dueAt: at('18:00'), createdAt: 1, data: { updatedAt: 1, minutes, ...extra } })

test('auto schedule preserves fixed appointments and fills gaps without overlap', () => {
  const list = [item('fixed', 60, { fixedAt: at('10:00') }), item('important', 45, { priority: 1 }), item('regular', 45), item('small', 15)]
  const result = autoSchedule(list, at('09:00'), at('18:00'))
  expect(result.scheduled.get('important')).toBe(at('09:00'))
  expect(result.scheduled.get('regular')).toBe(at('11:00'))
  expect(result.scheduled.has('fixed')).toBe(false)
  expect(result.overflow).toEqual([])
})
test('a task too large for today does not prevent smaller tasks fitting', () => {
  const result = autoSchedule([item('huge', 480, { priority: 1 }), item('small', 15)], at('19:00'), at('20:00'))
  expect(result.overflow).toEqual(['huge'])
  expect(result.scheduled.get('small')).toBe(at('19:00'))
})
test('finished, dismissed, future tasks and notes are excluded from automatic scheduling', () => {
  const result = autoSchedule([{ ...item('done', 15), status: 'done' }, { ...item('deleted', 15), status: 'dismissed' }, { ...item('note', 15), kind: 'memo' }, { ...item('tomorrow', 15), dueAt: dayEnd(at('12:00')) + 1 }], at('09:00'), at('18:00'))
  expect(result.scheduled.size).toBe(0)
})
test('strict local dates reject silent Date overflow and preserve local clock', () => {
  expect(parseSchedule('', '')).toBeNull()
  expect(new Date(at('09:30')).getHours()).toBe(9)
  expect(() => parseSchedule('2026-02-31', '09:00')).toThrow()
  expect(() => parseSchedule('2026-11-11', '24:01')).toThrow()
  expect(estimateMinutes('准备项目报告')).toBe(45)
})
test('newer tombstone wins and older remote data never resurrects removed notes', () => {
  const local = { ...item('same', 15), status: 'dismissed' as const, data: { updatedAt: 20 } }
  expect(mergeWorkItems([local], [item('same', 15)])[0].status).toBe('dismissed')
  expect(mergeWorkItems([item('same', 15)], [local])[0].status).toBe('dismissed')
})

test('configured working time, breaks and buffers are respected', () => {
  const planning = { start: 9 * 60, end: 18 * 60, breakStart: 12 * 60, breakEnd: 13 * 60, buffer: 10 }
  const result = autoSchedule([item('a', 60), item('b', 60), item('c', 60), item('d', 60)], at('08:00'), at('18:00'), planning)
  expect(result.scheduled.get('a')).toBe(at('09:00'))
  expect(result.scheduled.get('b')).toBe(at('10:10'))
  expect(result.scheduled.get('c')).toBe(at('13:00'))
  expect(result.scheduled.get('d')).toBe(at('14:10'))
})
