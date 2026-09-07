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

test('a cloud CLI that changes the machines is infra', () => {
  assert.equal(kind('kubectl apply -f k8s/deploy.yaml'), 'infra')
  assert.equal(kind('kubectl delete pod api-7d8f9'), 'infra')
  assert.equal(kind('kubectl rollout restart deploy/api'), 'infra')
  assert.equal(kind('aws s3 cp out.json s3://bucket/out.json'), 'infra')
  assert.equal(kind('aws ecs update-service --service list'), 'infra')
  assert.equal(kind('gcloud auth login'), 'infra')
  assert.equal(kind('gcloud run deploy api'), 'infra')
  assert.equal(kind('terraform apply -auto-approve'), 'infra')
  assert.equal(kind('docker build -t app .'), 'infra')
  assert.equal(kind('docker compose up -d'), 'infra')
  assert.equal(kind('helm upgrade --install app ./chart'), 'infra')
  assert.equal(kind('systemctl restart nginx'), 'infra')
  // Not a multiplexer, so it is named on its own row. Switching context changes the machine.
  assert.equal(kind('kubectx staging'), 'infra')
  // A verb in neither table falls this way rather than the other: an unread verb is filed as
  // changing the machines, which is the direction to be wrong in.
  assert.equal(kind('kubectl config use-context prod'), 'infra')
  assert.equal(kind('vagrant halt'), 'infra')
})

test('a cloud CLI that only reports on the machines is a probe', () => {
  // The same split `read` is to `edit`, one layer out. Reading a cluster to work out what is
  // going on is reconstruction, and it is where most of a real store's infra calls sit.
  assert.equal(kind('kubectl get pods -n prod'), 'probe')
  assert.equal(kind('kubectl logs -f api-7d8f9'), 'probe')
  assert.equal(kind('kubectl describe pod api-7d8f9'), 'probe')
  assert.equal(kind('kubectl rollout status deploy/api'), 'probe')
  assert.equal(kind('aws sts get-caller-identity'), 'probe')
  assert.equal(kind('aws ec2 describe-instances --region us-east-1'), 'probe')
  assert.equal(kind('aws s3 ls s3://bucket/'), 'probe')
  assert.equal(kind('gcloud secrets versions access latest --secret=KEY'), 'probe')
  assert.equal(kind('terraform plan -out=tf.plan'), 'probe')
  assert.equal(kind('docker ps -a'), 'probe')
  assert.equal(kind('helm list -n prod'), 'probe')
  assert.equal(kind('systemctl status nginx'), 'probe')
  // These two only ever read.
  assert.equal(kind('journalctl -u api -n 200'), 'probe')
  assert.equal(kind('stern api --since 5m'), 'probe')
})

test('a namespace is not a subcommand', () => {
  // The commonest shape there is in a store that touches a cluster. Read as a subcommand it gives
  // one row per namespace and hides the verb that says whether anything changed.
  assert.deepEqual(names('kubectl -n ocana-agents get pods'), ['kubectl get'])
  assert.equal(kind('kubectl -n ocana-agents get pods'), 'probe')
  assert.deepEqual(names('kubectl --context prod -o json get pods'), ['kubectl get'])
  assert.deepEqual(names('aws --region us-east-1 --profile prod ec2 describe-instances'), ['aws ec2'])
  // Only for the cloud CLIs: `-n` is a dry run to `make` and swallows nothing.
  assert.deepEqual(names('make -n build'), ['make build'])
})

test('a pod or container name does not become a row of its own', () => {
  // `npm run build` is worth the third token because a script name is the work. What follows
  // `kubectl exec` is a pod, and naming rows after pods gives every pod a row.
  assert.deepEqual(names('kubectl exec api-7d8f9 -- sh -c "ls"'), ['kubectl exec'])
  assert.deepEqual(names('docker run -it node:20 bash'), ['docker run'])
  assert.deepEqual(names('npm run build'), ['npm run build'])
})

test('a command handed to another machine is counted as what it ran there', () => {
  // The row stays named after the handing-off, so pods still do not each get one, but the kind
  // comes from the payload: these are a `Read` and a `Grep` with a cluster in the middle.
  assert.deepEqual(names('kubectl exec -n prod api-7d8f9 -c gateway -- cat /opt/app/config.json'), ['kubectl exec'])
  assert.equal(kind('kubectl exec -n prod api-7d8f9 -c gateway -- cat /opt/app/config.json'), 'read')
  assert.equal(kind('kubectl exec api-7d8f9 -- ls /usr/local/lib'), 'search')
  assert.equal(kind('kubectl exec api-7d8f9 -- rm -rf /tmp/cache'), 'edit')
  // The scaffolding a script opens with is skipped the same way it is one level up.
  assert.equal(kind('kubectl exec api-7d8f9 -- sh -c "export HOME=/root && grep -rn boot /var/log"'), 'search')
  assert.equal(
    kind(`aws ssm send-command --instance-ids i-079 --document-name AWS-RunShellScript --parameters 'commands=["grep -E \\"Provisioning\\" /opt/app/logs/combined.log"]'`),
    'search',
  )
  assert.equal(
    kind(`aws ssm send-command --instance-ids i-079 --parameters '{"commands":["export HOME=/home/ec2-user","cat /opt/app/state.json"]}'`),
    'read',
  )
})

test('an unreadable payload leaves the call as what it was', () => {
  // A container whose name mentions tests is still not a test run, and an inner command nothing
  // recognizes is not evidence about the outer one.
  assert.equal(kind('docker exec test-db psql -c "select 1"'), 'infra')
  assert.equal(kind('kubectl exec api-7d8f9 -- psql -c "select 1"'), 'infra')
  // Built by a subshell, so there is no literal script to read.
  assert.equal(
    kind(`aws ssm send-command --instance-ids i-079 --parameters "{\\"commands\\":[$(python3 -c 'print(1)')]}"`),
    'infra',
  )
  // No payload at all: a session is opened, nothing is said about what happens in it.
  assert.equal(kind('aws ssm start-session --target i-079'), 'infra')
})

test('an assignment whose value is a command is that command', () => {
  // Capturing output into a variable is how a shell script calls anything it needs the result of,
  // and it is most of what a cluster session looks like. Dropping the assignment token whole took
  // the program with it and left the subcommand standing alone: rows called `ssm` and `get`.
  assert.deepEqual(names('CMD_ID=$(aws ssm send-command --instance-ids i-079)'), ['aws ssm'])
  assert.deepEqual(names('POD=$(kubectl get pod -n ns -o name)'), ['kubectl get'])
  assert.equal(kind('POD=$(kubectl get pod -n ns -o name)'), 'probe')
  assert.deepEqual(names('SHA=`git rev-parse HEAD`'), ['git rev-parse'])
  // Neither of these holds a command, so both still drop to what follows.
  assert.deepEqual(names('NODE_ENV=test npm test'), ['npm test'])
  assert.deepEqual(names('DIR=$HOME ls $DIR'), ['ls'])
})

test('waiting is not work on the machine', () => {
  // `sleep` was the largest single row in a real store's environment category, almost all of it
  // the pause between sending a remote command and collecting its output — and at one weight per
  // command in a call, it was charged half of the work it was waiting for.
  assert.equal(kind('sleep 30'), 'shell')
  assert.deepEqual(names('sleep 5 && kubectl get pods'), ['sleep', 'kubectl get'])
  // Looking at what is running, and stopping it, still are.
  assert.equal(kind('ps aux'), 'proc')
  assert.equal(kind('kill -9 4821'), 'proc')
})
