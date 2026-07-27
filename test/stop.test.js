const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const SRC = path.join(__dirname, '..', 'src');

// Inputs reach the action through INPUT_* variables, and both config and the
// GitHub client are module singletons, so every case builds the world from
// scratch and drops the modules from the require cache afterwards.
function loadGh({ runnerStates, deleteResponses, timeoutMinutes = 1 }) {
  process.env.GITHUB_REPOSITORY = 'JetBrains/jcp-air';
  process.env['INPUT_MODE'] = 'stop';
  process.env['INPUT_EC2-INSTANCE-ID'] = 'i-0test';
  process.env['INPUT_LABEL'] = 't8og1';
  process.env['INPUT_GITHUB-TOKEN'] = 'token';
  process.env['INPUT_AWS-RESOURCE-TAGS'] = '[]';
  process.env['INPUT_SHUTDOWN-RETRY-INTERVAL-SECONDS'] = '0.01';
  process.env['INPUT_SHUTDOWN-TIMEOUT-MINUTES'] = String(timeoutMinutes);

  const calls = { list: 0, delete: 0 };
  const github = require('@actions/github');
  github.getOctokit = () => ({
    paginate: async () => {
      const state = runnerStates[Math.min(calls.list, runnerStates.length - 1)];
      calls.list += 1;
      return state === null ? [] : [{ id: 42, name: 'ip-10-129-94-167', busy: state, labels: [{ name: 't8og1' }] }];
    },
    request: async () => {
      const response = deleteResponses[Math.min(calls.delete, deleteResponses.length - 1)];
      calls.delete += 1;
      if (response !== 'ok') throw Object.assign(new Error('Bad request - Runner is currently running a job'), { status: response });
      return {};
    },
  });

  return { gh: require(path.join(SRC, 'gh.js')), calls };
}

beforeEach(() => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key];
  }
});

test('waits for a runner that is still busy after its job completed', async () => {
  const { gh, calls } = loadGh({ runnerStates: [true, true, false], deleteResponses: ['ok'] });
  await gh.removeRunner();
  assert.equal(calls.list, 3);
  assert.equal(calls.delete, 1);
});

test('retries a DELETE rejected with 400 because the busy flag had not cleared yet', async () => {
  const { gh, calls } = loadGh({ runnerStates: [false], deleteResponses: [400, 'ok'] });
  await gh.removeRunner();
  assert.equal(calls.delete, 2);
});

test('stops once an ephemeral runner has unregistered itself', async () => {
  const { gh, calls } = loadGh({ runnerStates: [true, null], deleteResponses: ['ok'] });
  await gh.removeRunner();
  assert.equal(calls.delete, 0);
});

test('fails once the runner has stayed busy past the timeout', async () => {
  const { gh } = loadGh({ runnerStates: [true], deleteResponses: ['ok'], timeoutMinutes: 0.002 });
  await assert.rejects(gh.removeRunner(), /still running a job after/);
});

test('propagates a removal error that is not the busy race', async () => {
  const { gh, calls } = loadGh({ runnerStates: [false], deleteResponses: [403] });
  await assert.rejects(gh.removeRunner());
  assert.equal(calls.delete, 1);
});

test('terminates the instance even when the runner could not be removed', async () => {
  const order = [];
  const gh = { removeRunner: async () => { order.push('remove'); throw new Error('boom'); } };
  const aws = { terminateEc2Instance: async () => order.push('terminate') };

  process.env['INPUT_MODE'] = 'stop';
  process.env['INPUT_EC2-INSTANCE-ID'] = 'i-0test';
  process.env['INPUT_AWS-RESOURCE-TAGS'] = '[]';
  require.cache[require.resolve(path.join(SRC, 'gh.js'))] = { exports: gh };
  require.cache[require.resolve(path.join(SRC, 'aws.js'))] = { exports: aws };
  require(path.join(SRC, 'index.js'));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(order, ['remove', 'terminate']);
  // index.js reports the swallowed failure through core.setFailed, which marks
  // the whole test process as failed unless it is cleared here.
  process.exitCode = 0;
});
