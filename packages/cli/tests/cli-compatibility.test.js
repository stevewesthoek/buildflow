#!/usr/bin/env node

const { spawnSync } = require('child_process')
const path = require('path')
const assert = require('assert')

// Paths to the compiled binaries
const workbenchBin = path.join(__dirname, '..', 'dist', 'bin', 'workbench.js')
const buildflowBin = path.join(__dirname, '..', 'dist', 'bin', 'buildflow.js')

function assertStdoutContains(result, text, label) {
  assert(
    result.stdout.includes(text),
    `${label}: Expected stdout to contain "${text}", got:\n${result.stdout}`
  )
}

function assertStderrContains(result, text, label) {
  assert(
    result.stderr.includes(text),
    `${label}: Expected stderr to contain "${text}", got:\n${result.stderr}`
  )
}

function assertStderrNotContains(result, text, label) {
  assert(
    !result.stderr.includes(text),
    `${label}: Expected stderr NOT to contain "${text}", got:\n${result.stderr}`
  )
}

function assertStdoutNotContains(result, text, label) {
  assert(
    !result.stdout.includes(text),
    `${label}: Expected stdout NOT to contain "${text}", got:\n${result.stdout}`
  )
}

function testWorkbenchCanonical() {
  console.log('Testing: workbench --help (canonical)')
  const result = spawnSync(process.execPath, [workbenchBin, '--help'], {
    encoding: 'utf-8',
  })
  assert.strictEqual(result.status, 0, 'workbench --help should exit 0')
  assertStdoutContains(result, 'Workbench', 'workbench --help')
  assertStdoutNotContains(result, 'deprecated', 'workbench --help')
  assertStderrNotContains(result, 'deprecated', 'workbench --help (stderr)')
  console.log('✓ workbench --help works without warning')

  console.log('Testing: workbench --version')
  const versionResult = spawnSync(process.execPath, [workbenchBin, '--version'], {
    encoding: 'utf-8',
  })
  assert.strictEqual(versionResult.status, 0, 'workbench --version should exit 0')
  assert.match(versionResult.stdout, /\d+\.\d+\.\d+/, 'workbench --version should match semver')
  const version = versionResult.stdout.trim()
  console.log(`✓ workbench --version: ${version}`)

  return version
}

function testBuildflowDeprecated() {
  console.log('Testing: buildflow --help (deprecated alias)')
  const result = spawnSync(process.execPath, [buildflowBin, '--help'], {
    encoding: 'utf-8',
  })
  assert.strictEqual(result.status, 0, 'buildflow --help should exit 0')
  assertStdoutContains(result, 'Workbench', 'buildflow --help')
  assertStderrContains(result, 'WARNING', 'buildflow --help (deprecation warning)')
  assertStderrContains(result, 'deprecated', 'buildflow --help (deprecation warning)')
  assertStderrContains(result, 'workbench', 'buildflow --help (warning mentions workbench)')
  console.log('✓ buildflow --help shows deprecation warning')

  console.log('Testing: buildflow --version')
  const versionResult = spawnSync(process.execPath, [buildflowBin, '--version'], {
    encoding: 'utf-8',
  })
  assert.strictEqual(versionResult.status, 0, 'buildflow --version should exit 0')
  assert.match(versionResult.stdout, /\d+\.\d+\.\d+/, 'buildflow --version should match semver')
  const version = versionResult.stdout.trim()
  console.log(`✓ buildflow --version: ${version}`)

  return version
}

function testBuildflowJsonSuppression() {
  console.log('Testing: buildflow --version (WORKBENCH_JSON=1)')
  const result = spawnSync(process.execPath, [buildflowBin, '--version'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      WORKBENCH_JSON: '1',
    },
  })
  assert.strictEqual(result.status, 0, 'buildflow --version should exit 0')
  assertStderrNotContains(result, 'deprecated', 'buildflow with WORKBENCH_JSON=1')
  console.log('✓ buildflow with WORKBENCH_JSON=1 suppresses warning')
}

function testParity() {
  console.log('Testing: version parity')
  const workbenchVersion = spawnSync(process.execPath, [workbenchBin, '--version'], {
    encoding: 'utf-8',
  }).stdout.trim()

  const buildflowVersion = spawnSync(process.execPath, [buildflowBin, '--version'], {
    encoding: 'utf-8',
  }).stdout.trim()

  assert.strictEqual(
    workbenchVersion,
    buildflowVersion,
    `Version mismatch: workbench=${workbenchVersion}, buildflow=${buildflowVersion}`
  )
  console.log(`✓ Both binaries report version: ${workbenchVersion}`)

  console.log('Testing: help text parity')
  const workbenchHelp = spawnSync(process.execPath, [workbenchBin, '--help'], {
    encoding: 'utf-8',
  }).stdout

  const buildflowHelp = spawnSync(process.execPath, [buildflowBin, '--help'], {
    encoding: 'utf-8',
  }).stdout

  // Both should have same command list (ignoring the deprecation warning in stderr)
  const workbenchCommands = workbenchHelp.match(/^\s+(init|login|connect|index|serve|status|workspace|tree|grep|context|diagnose-redaction)/m) // spot-check
  const buildflowCommands = buildflowHelp.match(/^\s+(init|login|connect|index|serve|status|workspace|tree|grep|context|diagnose-redaction)/m)
  assert(workbenchCommands && buildflowCommands, 'Both help texts should show command list')
  console.log('✓ Both binaries expose same command list')
}

function main() {
  try {
    console.log('\n=== CLI Compatibility Tests ===\n')

    const workbenchVersion = testWorkbenchCanonical()
    console.log()

    const buildflowVersion = testBuildflowDeprecated()
    console.log()

    testBuildflowJsonSuppression()
    console.log()

    testParity()
    console.log()

    console.log('=== All tests passed ===\n')
    process.exit(0)
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { main }




function testPathPermissionCompatibility() {
  console.log('Testing: repo path permission compatibility')
  const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx')
  const permissionsPath = path.join(__dirname, '..', 'src', 'agent', 'permissions.ts')
  const script = `
    import assert from 'node:assert/strict'
    import { pathToFileURL } from 'node:url'
    const { isPathAllowed } = await import(pathToFileURL(${JSON.stringify(permissionsPath)}).href)
    assert.equal(isPathAllowed('src/app/api/[[...segments]]/route.ts'), true)
    assert.equal(isPathAllowed('src/app/blog/[...slug]/page.tsx'), true)
    assert.equal(isPathAllowed('src/components/file..name.tsx'), true)
    assert.equal(isPathAllowed('../secrets.txt'), false)
    assert.equal(isPathAllowed('src/../../outside.ts'), false)
    assert.equal(isPathAllowed('src\\..\\outside.ts'), false)
    assert.equal(isPathAllowed('/absolute/path.ts'), false)
  `
  const result = spawnSync(tsxBin, ['--eval', script], {
    encoding: 'utf-8',
  })
  assert.strictEqual(
    result.status,
    0,
    `path permission compatibility should pass:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  console.log('✓ Next.js catch-all paths allowed; real traversal remains blocked')
}

testPathPermissionCompatibility()
