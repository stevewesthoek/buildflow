import type { ActiveSourcesMode, WriteMode } from '@workbench/shared'

import { DashboardButton } from './ui/DashboardButton'
import { DashboardMetaRow } from './ui/DashboardMetaRow'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'

type ActiveContextPanelProps = {
  activeMode: ActiveSourcesMode
  writeMode: WriteMode
  activeSourceIds: string[]
  onSetMode: (mode: ActiveSourcesMode) => void
  onSetWriteMode: (mode: WriteMode) => void
}

const modeButtons: Array<{ id: ActiveSourcesMode; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'multi', label: 'Multi' },
  { id: 'all', label: 'All' }
]

const writeButtons: Array<{ id: WriteMode; label: string }> = [
  { id: 'readOnly', label: 'Read only' },
  { id: 'artifactsOnly', label: 'Artifacts only' },
  { id: 'safeWrites', label: 'Safe writes' }
]

export function ActiveContextPanel({
  activeMode,
  writeMode,
  activeSourceIds,
  onSetMode,
  onSetWriteMode
}: ActiveContextPanelProps) {
  return (
    <div className="space-y-3">
      <DashboardPanel variant="flat" className="p-4">
        <DashboardSectionHeader
          eyebrow="Context"
          title="Active context"
          detail="Choose how BuildFlow scopes sources and writes."
        />
        <div className="mt-4 grid grid-cols-3 gap-2">
          {modeButtons.map(button => {
            const active = activeMode === button.id
            return (
              <DashboardButton
                key={button.id}
                type="button"
                onClick={() => onSetMode(button.id)}
                variant={active ? 'primary' : 'secondary'}
                className="h-7 w-full justify-center text-[12px]"
              >
                {button.label}
              </DashboardButton>
            )
          })}
        </div>
        <div className="mt-3">
          <DashboardMetaRow
            label="Sources"
            value={activeSourceIds.length > 0 ? `${activeSourceIds.length} selected` : 'All enabled'}
            className="text-[12px]"
          />
        </div>
      </DashboardPanel>

      <DashboardPanel variant="flat" className="p-4">
        <DashboardSectionHeader eyebrow="Write" title="Write mode" />
        <div className="mt-4 grid gap-2">
          {writeButtons.map(button => {
            const active = writeMode === button.id
            return (
              <DashboardButton
                key={button.id}
                type="button"
                onClick={() => onSetWriteMode(button.id)}
                variant={active ? 'primary' : 'secondary'}
                className="h-7 w-full justify-start px-3 text-[12px]"
              >
                {button.label}
              </DashboardButton>
            )
          })}
        </div>
      </DashboardPanel>
    </div>
  )
}
