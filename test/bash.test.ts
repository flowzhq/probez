import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCommands } from '../src/bash.js'

/** Just the names, which is what the table shows. */
function names(command: string): string[] {
  return parseCommands(command).map((c) => c.name)
}

/** The kind of the first command, for the cases where classification is the point. */
function kind(command: string): string | undefined {
  return parseCommands(command)[0]?.kind
}

test('a call that runs several commands yields all of them', () => {
  assert.deepEqual(names('cd /tmp/work && npm test'), ['cd', 'npm test'])
  assert.deepEqual(names('git add -A && git commit -m "fix"'), ['git add', 'git commit'])
  assert.deepEqual(names('mkdir -p out; cp a out/; ls out'), ['mkdir', 'cp', 'ls'])
})

test('the same command twice in one call counts once', () => {
  assert.deepEqual(names('grep -r foo src | grep -v test'), ['grep'])
})

test('a program is named by the first argument that says what it did', () => {
  assert.deepEqual(names('git log --oneline -20'), ['git log'])
  assert.deepEqual(names('npm run build'), ['npm run build'])
  assert.deepEqual(names('gh pr view 12 --json title'), ['gh pr'])
  // A path argument is not a script name, so `go run` stops where it stops being informative.
  assert.deepEqual(names('go run ./cmd/server'), ['go run'])
  // Without this, --filter's value names the row after the package instead of the script.
  assert.deepEqual(names('pnpm --filter @scope/core test'), ['pnpm test'])
  // A wrapped line puts a backslash between the program and its subcommand.
  assert.deepEqual(names('git \\\n  rev-parse HEAD'), ['git rev-parse'])
})

test('wrappers, assignments and loop keywords are not commands', () => {
  assert.deepEqual(names('sudo rm -rf build'), ['rm'])
  assert.deepEqual(names('timeout 30 node script.js'), ['node'])
  assert.deepEqual(names('SP=/tmp/scratch; grep -n foo "$SP/log"'), ['grep'])
  assert.deepEqual(names('for f in *.ts; do grep -c export "$f"; done'), ['grep'])
})

test('an inline credential never reaches a row', () => {
  // Assignments are stripped before anything is named, so the value cannot become a command and
  // the row carries the program only. The tally shows command names, never command strings.
  assert.deepEqual(names('TOKEN=ghp_notarealtokenatall gh api /user'), ['gh api'])
})

test('a program is named by its basename, however it was reached', () => {
  assert.deepEqual(names('tools/scanner-cli/bin/flowz scan .'), ['flowz'])
  assert.deepEqual(names('./scripts/check.sh --fix'), ['check.sh'])
  assert.deepEqual(names('~/.local/bin/probez collect'), ['probez'])
})

test('quoting is respected, so strings do not become commands', () => {
  // Splitting blindly on ; and newlines turns these into commands called `import` and `FAIL`.
  assert.deepEqual(names("python3 -c 'import os; print(os.getcwd())'"), ['python3'])
  assert.deepEqual(names('echo "Tests: 3 passed | 1 FAIL"'), ['echo'])
  assert.deepEqual(names('grep -c "a;b" src/x.ts'), ['grep'])
})

test('a heredoc body is data, not commands', () => {
  assert.deepEqual(names("python3 - <<'EOF'\nimport json\nprint(1)\nEOF"), ['python3'])
})

test('a command substitution decorates a call rather than being it', () => {
  assert.deepEqual(names('echo "$(cat VERSION | head -1)"'), ['echo'])
})

test('redirection debris is not a program', () => {
  assert.deepEqual(names('node build.js > out.log 2>&1'), ['node'])
  assert.deepEqual(names('make verify 2>&1 | tail -40'), ['make verify', 'tail'])
})

test('a command line with nothing readable in it yields nothing', () => {
  assert.deepEqual(names(''), [])
  assert.deepEqual(names('# just a comment'), [])
  assert.deepEqual(names('$CMD --help'), [])
  assert.deepEqual(parseCommands(null), [])
  assert.deepEqual(parseCommands({ command: 'ls' }), [])
})

test('sed reads or edits depending on how it was called', () => {
  // The distinction matters: sed is one of the most-used commands in a real store, and it is
  // mostly a pager. Folding both into one kind would be the largest single misclassification.
  assert.equal(kind("sed -n '1,40p' src/cli.ts"), 'read')
  assert.equal(kind("sed -i '' 's/a/b/' src/cli.ts"), 'edit')
  assert.equal(kind("perl -pe 's/a/b/' x"), 'read')
  assert.equal(kind("perl -pi -e 's/a/b/' x"), 'edit')
})

test('kinds follow what the command does, not who ran it', () => {
  assert.equal(kind('grep -rn foo src'), 'search')
  assert.equal(kind('cat README.md'), 'read')
  assert.equal(kind('git commit -m "x"'), 'vcs')
  assert.equal(kind('go test ./...'), 'test')
  assert.equal(kind('npx vitest run'), 'test')
  // A script named for testing is a test run under any runner.
  assert.equal(kind('pnpm test:coverage'), 'test')
  assert.equal(kind('make test-graph-core'), 'test')
  assert.equal(kind('npm run test:unit'), 'test')
  assert.equal(kind('npm run build'), 'build')
  assert.equal(kind('pnpm install --frozen-lockfile'), 'deps')
  assert.equal(kind('curl -s https://example.com'), 'net')
  assert.equal(kind('cd src'), 'nav')
  // An unrecognized program is `other`, not a guess at what it might do.
  assert.equal(kind('flowz scan'), 'other')
})

test('a container or cloud CLI is infra whatever its subcommand does', () => {
  // Reading a cluster and changing one are the same kind here: both are work on the machines the
  // code runs on. Before this they were `other`, alongside the programs nothing recognized.
  assert.equal(kind('kubectl get pods -n prod'), 'infra')
  assert.equal(kind('kubectl apply -f k8s/deploy.yaml'), 'infra')
  assert.equal(kind('aws s3 cp out.json s3://bucket/out.json'), 'infra')
  assert.equal(kind('gcloud auth login'), 'infra')
  assert.equal(kind('terraform plan -out=tf.plan'), 'infra')
  assert.equal(kind('docker build -t app .'), 'infra')
  assert.equal(kind('helm upgrade --install app ./chart'), 'infra')
  assert.equal(kind('systemctl restart nginx'), 'infra')
  // Not a multiplexer, so it is named on its own row.
  assert.equal(kind('kubectx staging'), 'infra')
  // A container whose name mentions tests is still not a test run: the head is read first.
  assert.equal(kind('docker exec test-db psql -c "select 1"'), 'infra')
})

test('a pod or container name does not become a row of its own', () => {
  // `npm run build` is worth the third token because a script name is the work. What follows
  // `kubectl exec` is a pod, and naming rows after pods gives every pod a row.
  assert.deepEqual(names('kubectl exec api-7d8f9 -- sh -c "ls"'), ['kubectl exec'])
  assert.deepEqual(names('docker run -it node:20 bash'), ['docker run'])
  assert.deepEqual(names('npm run build'), ['npm run build'])
})
