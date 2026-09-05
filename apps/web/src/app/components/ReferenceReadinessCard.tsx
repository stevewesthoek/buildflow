type ReadinessItem = {
  key: string
  label: string
  detail: string
}

const readinessItems: ReadinessItem[] = [
  {
    key: 'context',
    label: 'Context available',
    detail: 'Inspect the exact files and sources needed for each task.'
  },
  {
    key: 'guarded-writes',
    label: 'Guarded writes',
    detail: 'Apply bounded changes with an explicit path and review boundary.'
  },
  {
    key: 'targeted-validation',
    label: 'Targeted validation',
    detail: 'Run the smallest meaningful checks before creating a commit.'
  }
]

export default function ReferenceReadinessCard() {
  return (
    <section
      aria-labelledby="reference-readiness-title"
      aria-label="Reference app readiness: ready"
      className="mt-12 rounded-xl border border-indigo-100 bg-white/90 p-6 text-left shadow-sm"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Reference app</p>
          <h2 id="reference-readiness-title" className="mt-1 text-2xl font-bold text-gray-900">
            Local readiness at a glance
          </h2>
          <p className="mt-2 max-w-2xl text-gray-600">
            A compact view of the safe workflow behind every Workbench change.
          </p>
        </div>
        <span className="inline-flex w-fit items-center rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700">
          Ready
        </span>
      </div>

      <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3" role="list">
        {readinessItems.map((item) => (
          <li key={item.key} data-testid={item.key} className="rounded-lg border border-gray-100 bg-gray-50 p-4">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 text-lg font-bold text-emerald-600">✓</span>
              <div>
                <h3 className="font-semibold text-gray-900">{item.label}</h3>
                <p className="mt-1 text-sm leading-6 text-gray-600">{item.detail}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
