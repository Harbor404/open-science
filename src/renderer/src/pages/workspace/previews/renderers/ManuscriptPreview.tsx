import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PrepareManuscriptResult } from '../../../../../../shared/manuscripts'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'

type PrepareState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; value: PrepareManuscriptResult }

export const ManuscriptPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const { item } = props
  const { t } = useTranslation()
  const previewState = usePreviewFileContent(item)
  const [prepareState, setPrepareState] = useState<PrepareState>({ status: 'loading' })
  const previewContent =
    previewState.status === 'ready' && previewState.preview.encoding === 'utf8'
      ? previewState.preview.content
      : undefined
  const previewTruncated = previewState.status === 'ready' && previewState.preview.truncated

  useEffect(() => {
    if (previewContent === undefined || previewTruncated) {
      return
    }
    let canceled = false
    setPrepareState({ status: 'loading' })
    void window.api.manuscripts
      .prepare({
        projectId: item.projectId ?? 'default-project',
        appSessionId: item.sessionId,
        content: previewContent
      })
      .then((value) => {
        if (!canceled) setPrepareState({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!canceled) setPrepareState({ status: 'error', error })
      })
    return () => {
      canceled = true
    }
  }, [item.projectId, item.sessionId, previewContent, previewTruncated])

  if (previewState.status === 'loading') return <PreviewLoadingContent />

  if (previewState.status === 'error' || previewState.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={previewState.status === 'error' ? previewState.error : undefined}
        fallbackMessage={t("Markdown couldn't be read for preview")}
      />
    )
  }

  if (previewState.preview.truncated || previewState.pagination.pageNumber > 1) {
    return (
      <PreviewTextAnnotationSurface {...props}>
        <SourcePreviewContent
          content={previewState.preview.content}
          pagination={previewState.pagination}
        />
      </PreviewTextAnnotationSurface>
    )
  }

  if (prepareState.status === 'loading') return <PreviewLoadingContent />
  if (prepareState.status === 'error') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={prepareState.error}
        fallbackMessage={
          prepareState.error instanceof Error
            ? prepareState.error.message
            : String(prepareState.error)
        }
      />
    )
  }

  return (
    <PreviewTextAnnotationSurface {...props}>
      <div
        className={
          props.presentation === 'search' ? 'w-full' : 'size-full overflow-auto bg-bg-10 p-4'
        }
      >
        <AgentMarkdown content={prepareState.value.markdown} />
      </div>
    </PreviewTextAnnotationSurface>
  )
}
