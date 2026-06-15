import { DashboardCodeText } from './ui/DashboardCodeText'
import { DashboardMetaRow } from './ui/DashboardMetaRow'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'

export function InfoPanels() {
  return (
    <>
      <DashboardPanel variant="flat" className="p-4">
        <DashboardSectionHeader eyebrow="Execution" title="Execution modes" detail="Local agent and relay remain separate." />
        <div className="mt-4 space-y-2">
          <DashboardMetaRow label="Direct" value="Local agent (3052)" className="text-[12px]" />
          <DashboardMetaRow label="Relay" value="Via relay (3053)" className="text-[12px]" />
        </div>
        <p className="mt-3 text-[12px] text-bf-muted">
          Set via <DashboardCodeText>WORKBENCH_BACKEND_MODE</DashboardCodeText>
        </p>
      </DashboardPanel>

      <DashboardPanel variant="flat" className="p-4">
        <DashboardSectionHeader eyebrow="Setup" title="Local setup" detail="Keep the stack running locally." />
        <div className="mt-4 space-y-2 text-[12px] text-bf-muted">
          <div><DashboardCodeText>pnpm install</DashboardCodeText></div>
          <div><DashboardCodeText>pnpm local:restart</DashboardCodeText></div>
          <div>Open <DashboardCodeText>http://127.0.0.1:3054</DashboardCodeText></div>
          <div>See README.md for source setup and ChatGPT import.</div>
        </div>
      </DashboardPanel>
    </>
  )
}
