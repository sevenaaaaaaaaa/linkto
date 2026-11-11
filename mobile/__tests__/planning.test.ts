import { conflictsFor, defaultPlanning, parseMinute, reorderTarget, validatePlanning } from '../src/workbench/planning'
import type { WorkItem } from '../src/workbench/model'
const task = (id: string, at: number): WorkItem => ({ id, kind: 'todo', title: id, status: 'open', dueAt: at, createdAt: 1, data: { updatedAt: 1, minutes: 30 } })
test('adjacent tasks fit, overlapping tasks produce actionable conflicts', () => {
  const first = task('first', 3600000)
  expect(conflictsFor(first, [first, task('adjacent', 5400000)])).toEqual([])
  expect(conflictsFor(first, [first, task('collision', 4500000)]).map(i => i.id)).toEqual(['collision'])
})
test('drop positions follow measured variable-height cards and are bounded', () => {
  expect(reorderTarget(0, 80, [100, 180, 100])).toBe(1)
  expect(reorderTarget(2, -900, [100, 180, 100])).toBe(0)
  expect(reorderTarget(0, 5, [100, 100])).toBe(0)
})
test('invalid planning input never silently shifts hours or creates a backwards work day', () => {
  expect(parseMinute('09:30')).toBe(570)
  expect(() => parseMinute('25:00')).toThrow()
  expect(() => validatePlanning({ ...defaultPlanning, end: 400 })).toThrow()
})
