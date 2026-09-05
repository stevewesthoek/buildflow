import ReferenceReadinessCard from './components/ReferenceReadinessCard'

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-16">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="mb-4 text-5xl font-bold text-gray-900">ProChat Workbench</h1>
          <p className="mb-8 text-xl text-gray-600">
            Work safely with your local repositories, documentation, notes, and knowledge folders through ChatGPT.
          </p>

          <div className="space-y-4">
            <a
              href="/dashboard"
              className="inline-block rounded-lg bg-indigo-600 px-8 py-3 font-bold text-white transition hover:bg-indigo-700"
            >
              Open Workbench
            </a>
          </div>

          <ReferenceReadinessCard />

          <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-3">
            <div className="rounded-lg bg-white p-6 shadow">
              <h3 className="mb-2 text-lg font-bold text-gray-900">Use Exact Context</h3>
              <p className="text-gray-600">Let ChatGPT inspect the files and sources it needs instead of guessing.</p>
            </div>
            <div className="rounded-lg bg-white p-6 shadow">
              <h3 className="mb-2 text-lg font-bold text-gray-900">Make Guarded Changes</h3>
              <p className="text-gray-600">Apply verified edits and save useful work back to your local projects.</p>
            </div>
            <div className="rounded-lg bg-white p-6 shadow">
              <h3 className="mb-2 text-lg font-bold text-gray-900">Validate &amp; Commit</h3>
              <p className="text-gray-600">Run targeted checks and commit only the paths you approve.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
