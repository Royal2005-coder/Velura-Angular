import test from 'node:test';
import assert from 'node:assert/strict';
import { ClusterAiWorker } from '../../apps/api/src/ai/cluster-worker.js';

test('a refresh preserves fresh task readiness until its new observation completes, then revokes on denial', async () => {
  const delayed = Promise.withResolvers<Response>();
  let first = true;
  const http: typeof fetch = async () => {
    if (!first) return delayed.promise;
    first = false;
    return Response.json({ schema_version:'velura-worker-v1', ready:false, tasks:{image_quality:true} }, {status:503});
  };
  const worker = new ClusterAiWorker('http://worker.test', 'synthetic-private-worker-key-0000000000', http);
  await worker.refreshReadiness();
  assert.equal(worker.ready('image_quality'),true);
  const refresh = worker.refreshReadiness();
  assert.equal(worker.ready('image_quality'),true);
  delayed.resolve(Response.json({error_code:'WORKER_UNAUTHORIZED'},{status:401}));
  await refresh;
  assert.equal(worker.ready('image_quality'),false);
});
