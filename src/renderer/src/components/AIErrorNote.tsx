import { describeAIError } from '../lib/ai-error'

/**
 * AI 失败的就地提示：一句人话 + 一个动作按钮（去设置 AI / 重试 / 查看设置）。
 * 克制呈现：危险色小圆点 + 文字，按钮跟在句末随文字换行；用在 Reader AI 面板、洞察页、Agent 对话等内联位置
 */
export function AIErrorNote(props: { error: unknown; onRetry?: () => void; className?: string }) {
  const v = describeAIError(props.error, props.onRetry)
  return (
    <div role="alert" className={`flex items-start gap-2 text-xs leading-6 ${props.className ?? ''}`}>
      <span className="inline-block w-1.5 h-1.5 mt-[9px] rounded-full shrink-0" style={{ background: 'var(--danger)' }} />
      <span className="min-w-0">
        <span style={{ color: 'var(--danger-ink)' }}>{v.text}</span>
        {v.action && (
          <button
            onClick={v.action.run}
            className="no-drag ml-2 inline-flex items-center h-6 px-2.5 rounded-[var(--r-sm)] text-xs font-medium border border-[var(--border)] hover:bg-[var(--hover-strong)] transition-colors align-middle"
            style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }}
          >
            {v.action.label}
          </button>
        )}
      </span>
    </div>
  )
}
