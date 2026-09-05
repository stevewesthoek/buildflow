import assert from 'assert'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Indexer } from '../packages/cli/src/agent/indexer'

const writeText = async (filePath: string, content: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

const writeBinary = async (filePath: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3, 4, 5, 0, 6, 7]))
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'buildflow-reindex-fixture-'))
  const sourceDir = path.join(tempRoot, 'source')
  const sourceId = 'reindex-fixture'
  const indexer = new Indexer()
  const createdFiles: string[] = []

  try {
    await writeText(path.join(sourceDir, 'README.md'), '# Fixture\n\nReindex resilience test.\n')
    createdFiles.push(path.join(sourceDir, 'README.md'))
    await writeText(path.join(sourceDir, 'notes.txt'), 'alpha\n')
    createdFiles.push(path.join(sourceDir, 'notes.txt'))
    await writeText(path.join(sourceDir, 'docs', 'guide.md'), '# Guide\n')
    createdFiles.push(path.join(sourceDir, 'docs', 'guide.md'))

    for (let i = 0; i < 1200; i += 1) {
      const filePath = path.join(sourceDir, 'bulk', `file-${String(i).padStart(4, '0')}.md`)
      await writeText(filePath, `# File ${i}\n\nFixture content ${i}.\n`)
      createdFiles.push(filePath)
    }

    const skipDirs = ['node_modules', '.git', '.next', '.build', 'dist', 'build', 'coverage', '.cache', '.turbo', '.vercel', '.npm', '.yarn', '.pnpm-store']
    for (const dir of skipDirs) {
      await writeText(path.join(sourceDir, dir, 'ignored.md'), '# ignored\n')
      createdFiles.push(path.join(sourceDir, dir, 'ignored.md'))
    }
    await writeText(path.join(sourceDir, '.build', 'deep', 'release', 'artifacts', 'ignored.md'), '# ignored\n')
    createdFiles.push(path.join(sourceDir, '.build', 'deep', 'release', 'artifacts', 'ignored.md'))

    await writeBinary(path.join(sourceDir, 'binary.bin'))
    createdFiles.push(path.join(sourceDir, 'binary.bin'))

    const hugePath = path.join(sourceDir, 'huge.txt')
    await fs.writeFile(hugePath, 'a'.repeat(1024 * 1024 + 8))
    createdFiles.push(hugePath)

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 10)

    const startedAt = Date.now()
    const indexedFileCount = await indexer.buildIndexForSource(sourceId, sourceDir)
    const elapsedMs = Date.now() - startedAt
    clearInterval(ticker)

    const indexedDocs = indexer.getDocs().filter(doc => doc.sourceId === sourceId)
    const indexedPaths = indexedDocs.map(doc => doc.path)

    assert.ok(elapsedMs >= 0, 'elapsed time should be measurable')
    assert.ok(ticks > 0, 'indexing should yield to the event loop at least once')
    assert.ok(indexedFileCount >= 2, 'expected at least the top-level markdown and text files to be indexed')
    assert.ok(indexedPaths.includes('README.md'), 'README.md should be indexed')
    assert.ok(indexedPaths.includes('notes.txt'), 'notes.txt should be indexed')
    assert.ok(indexedPaths.includes(path.posix.join('docs', 'guide.md')), 'nested docs file should be indexed')
    assert.ok(!indexedPaths.some(item => item.includes('node_modules')), 'node_modules should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.git')), '.git should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.next')), '.next should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.build')), '.build should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('dist')), 'dist should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('build')), 'build should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('coverage')), 'coverage should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.cache')), '.cache should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.turbo')), '.turbo should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.vercel')), '.vercel should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.npm')), '.npm should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.yarn')), '.yarn should be skipped')
    assert.ok(!indexedPaths.some(item => item.includes('.pnpm-store')), '.pnpm-store should be skipped')
    assert.ok(!indexedPaths.includes('binary.bin'), 'binary files should be skipped')
    assert.ok(!indexedPaths.includes('huge.txt'), 'oversized files should be skipped')

    indexer.removeSourceDocs(sourceId)
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          indexedFileCount,
          elapsedMs,
          ticks,
          indexedPaths
        },
        null,
        2
      )
    )
    console.log('source reindex resilience checks passed')
  } finally {
    indexer.removeSourceDocs(sourceId)
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
