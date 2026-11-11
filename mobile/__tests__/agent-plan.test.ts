import { parseAgentResponse } from '../src/agent/plan'
const valid = { index: 0, summary: '客户需要回复', tasks: [{ title: '回复客户', detail: '请确认报价', minutes: 15 }] }
test('accepts bounded cited tasks and ignores unrecognized model instructions', () => {
  expect(parseAgentResponse(JSON.stringify({ entries: [{ ...valid, sendEmail: true }] }), 1)).toEqual([valid])
})
test.each([
  { entries: [{ ...valid, index: 1 }] },
  { entries: [valid, valid] },
  { entries: [{ ...valid, tasks: [{ title: '发送', detail: '', minutes: -15 }] }] },
  { entries: [{ ...valid, tasks: [{ title: '', detail: '', minutes: 15 }] }] },
  { execute: 'sendEmail' }
])('rejects invalid citations, duplicate mail and malformed tasks before saving: %j', value => {
  expect(() => parseAgentResponse(JSON.stringify(value), 1)).toThrow()
})
